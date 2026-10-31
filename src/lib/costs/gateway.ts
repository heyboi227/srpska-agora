import { and, count, desc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import type { Clock } from "@/lib/clock";
import type { AgoraConfig } from "@/lib/config/schema";
import type { Db, DbOrTx } from "@/lib/db/client";
import { budgetPeriods, costReservations, providerRequests } from "@/lib/db/schema";
import {
  ProviderCallError,
  ProviderNotConfiguredError,
  type ProviderBilling,
  type Usage,
} from "@/lib/providers/types";
import { utcDayStart, utcMonthStart, utcNextDayStart, utcNextMonthStart } from "@/lib/time";
import { actualCostMicros, estimateInputTokens, estimateUpperBoundMicros } from "./estimate";
import { findPrice, PRICE_TABLE, type ModelPrice, type PriceTable } from "./prices";
import { budgetStageFor, type BudgetStage } from "./stages";

export type CallOrigin = "scheduler" | "admin" | "system" | "eval" | "simulation";
export type CallPurpose = "generation" | "repair" | "validation" | "search";

export type RefusalReason = "paid_paused" | "budget_exhausted" | "no_price" | "busy";

export class BudgetRefusedError extends Error {
  constructor(
    readonly reason: RefusalReason,
    message: string,
  ) {
    super(message);
    this.name = "BudgetRefusedError";
  }
}

export interface GatewayDeps {
  db: Db;
  config: AgoraConfig;
  clock: Clock;
  prices?: PriceTable;
  /** Per-call timeout; a timed-out call is ambiguous. Default 45 s. */
  callTimeoutMs?: number;
  /** How long a call waits for a free in-flight slot. Default 20 s. */
  busyWaitMs?: number;
}

export interface CallMeta {
  actionKey: string | null;
  purpose: CallPurpose;
  origin: CallOrigin;
  provider: string;
  model: string;
  estimatePayload: unknown;
  maxOutputTokens: number;
}

const IN_FLIGHT_WINDOW_MS = 10 * 60_000;
const BUSY_POLL_MS = 1000;
const ERROR_MAX = 500;

const toMicros = (usd: number): number => Math.round(usd * 1e6);

/** What a failed call cost. Unknown failures may have cost money, so they are ambiguous. */
export function classifyBilling(error: unknown): ProviderBilling {
  if (error instanceof ProviderCallError) return error.billing;
  if (error instanceof ProviderNotConfiguredError) return "not_billed";
  return "ambiguous";
}

/** Short, key-free error text for the audit row. */
export function safeErrorText(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return raw
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .slice(0, ERROR_MAX);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type PeriodRow = typeof budgetPeriods.$inferSelect;

/** Locks the day row, then the month row; a fixed order prevents deadlocks. */
async function lockPeriods(tx: Tx, dayId: string, monthId: string): Promise<void> {
  await tx.select().from(budgetPeriods).where(eq(budgetPeriods.id, dayId)).for("update");
  await tx.select().from(budgetPeriods).where(eq(budgetPeriods.id, monthId)).for("update");
}

async function ensureAndLockPeriods(
  tx: Tx,
  now: Date,
  config: AgoraConfig,
): Promise<{ day: PeriodRow; month: PeriodRow }> {
  const windows = [
    {
      kind: "day" as const,
      start: utcDayStart(now),
      end: utcNextDayStart(now),
      limit: toMicros(config.budget.dailyVariableSpendLimit),
    },
    {
      kind: "month" as const,
      start: utcMonthStart(now),
      end: utcNextMonthStart(now),
      limit: toMicros(config.budget.monthlyVariableSpendLimit),
    },
  ];
  for (const w of windows) {
    await tx
      .insert(budgetPeriods)
      .values({
        kind: w.kind,
        periodStart: w.start,
        periodEnd: w.end,
        limitMicros: w.limit,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [budgetPeriods.kind, budgetPeriods.periodStart] });
  }
  const locked: PeriodRow[] = [];
  for (const w of windows) {
    const [row] = await tx
      .select()
      .from(budgetPeriods)
      .where(and(eq(budgetPeriods.kind, w.kind), eq(budgetPeriods.periodStart, w.start)))
      .for("update");
    if (!row) throw new Error("budget period row missing");
    if (row.limitMicros !== w.limit) {
      await tx
        .update(budgetPeriods)
        .set({ limitMicros: w.limit, updatedAt: now })
        .where(eq(budgetPeriods.id, row.id));
      row.limitMicros = w.limit;
    }
    locked.push(row);
  }
  return { day: locked[0]!, month: locked[1]! };
}

interface Reserved {
  reservationId: string;
  estimateMicros: number;
}

type ReserveOutcome =
  | { kind: "reserved"; value: Reserved }
  | { kind: "busy" }
  | { kind: "exhausted"; message: string };

export class CostGateway {
  private readonly prices: PriceTable;
  private readonly callTimeoutMs: number;
  private readonly busyWaitMs: number;

  constructor(private readonly deps: GatewayDeps) {
    this.prices = deps.prices ?? PRICE_TABLE;
    this.callTimeoutMs = deps.callTimeoutMs ?? 45_000;
    this.busyWaitMs = deps.busyWaitMs ?? 20_000;
  }

  async run<T extends { usage: Usage }>(
    meta: CallMeta,
    call: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const { db, config, clock } = this.deps;
    const inputTokens = estimateInputTokens(meta.estimatePayload);
    const price = findPrice(this.prices, meta.provider, meta.model);

    if (!price) {
      await this.recordRejected(meta, inputTokens, 0, "no_price");
      throw new BudgetRefusedError(
        "no_price",
        `No price for ${meta.provider}/${meta.model}; the call was not made.`,
      );
    }
    const estimate = estimateUpperBoundMicros(price, inputTokens, meta.maxOutputTokens);

    if (config.runtime.pausePaidActions && meta.origin !== "admin") {
      await this.recordRejected(meta, inputTokens, estimate, "paid_paused");
      throw new BudgetRefusedError("paid_paused", "Paid actions are paused.");
    }

    const deadline = Date.now() + this.busyWaitMs;
    let reserved: Reserved;
    for (;;) {
      const outcome = await this.tryReserve(meta, inputTokens, estimate);
      if (outcome.kind === "reserved") {
        reserved = outcome.value;
        break;
      }
      if (outcome.kind === "exhausted") {
        await this.recordRejected(meta, inputTokens, estimate, "budget_exhausted");
        throw new BudgetRefusedError("budget_exhausted", outcome.message);
      }
      if (Date.now() + BUSY_POLL_MS > deadline) {
        await this.recordRejected(meta, inputTokens, estimate, "busy");
        throw new BudgetRefusedError("busy", "Too many paid calls in flight.");
      }
      await sleep(BUSY_POLL_MS);
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(new Error(`Provider call timed out after ${this.callTimeoutMs} ms`)),
      this.callTimeoutMs,
    );
    const started = performance.now();
    let result: T;
    try {
      result = await raceAbort(call(controller.signal), controller.signal);
    } catch (error) {
      clearTimeout(timer);
      await this.settleFailure(reserved, price, error, Math.round(performance.now() - started));
      throw error;
    }
    clearTimeout(timer);
    const latencyMs = Math.round(performance.now() - started);
    const actual = actualCostMicros(price, result.usage);
    if (actual > reserved.estimateMicros) {
      console.warn(
        JSON.stringify({
          event: "cost_over_estimate",
          provider: meta.provider,
          model: meta.model,
          purpose: meta.purpose,
          estimateMicros: reserved.estimateMicros,
          actualMicros: actual,
        }),
      );
    }
    try {
      await resolveReservation(db, clock.now(), reserved.reservationId, {
        kind: "settle",
        actualMicros: actual,
        request: {
          status: "succeeded",
          ...usageColumns(result.usage),
          actualMicros: actual,
          latencyMs,
        },
      });
    } catch (settleError) {
      // The call succeeded and was paid for; keep the result. The reservation
      // stays open and reconciliation will move it on.
      console.error(`cost settlement failed: ${safeErrorText(settleError)}`);
    }
    return result;
  }

  private async settleFailure(
    reserved: Reserved,
    price: ModelPrice,
    error: unknown,
    latencyMs: number,
  ): Promise<void> {
    const { db, clock } = this.deps;
    const billing = classifyBilling(error);
    const text = safeErrorText(error);
    try {
      if (billing === "not_billed") {
        await resolveReservation(db, clock.now(), reserved.reservationId, {
          kind: "release",
          request: { status: "failed", error: text, latencyMs },
        });
      } else if (billing === "billed") {
        const usage = error instanceof ProviderCallError ? error.details.usage : undefined;
        const actual = usage ? actualCostMicros(price, usage) : reserved.estimateMicros;
        await resolveReservation(db, clock.now(), reserved.reservationId, {
          kind: "settle",
          actualMicros: actual,
          request: {
            status: "failed",
            ...(usage ? usageColumns(usage) : {}),
            actualMicros: actual,
            error: text,
            latencyMs,
          },
        });
      } else {
        await resolveReservation(db, clock.now(), reserved.reservationId, {
          kind: "ambiguous",
          request: { status: "ambiguous", error: text, latencyMs },
        });
      }
    } catch (settleError) {
      console.error(`cost settlement failed: ${safeErrorText(settleError)}`);
    }
  }

  private async tryReserve(
    meta: CallMeta,
    inputTokens: number,
    estimate: number,
  ): Promise<ReserveOutcome> {
    const { db, config, clock } = this.deps;
    return db.transaction(async (tx): Promise<ReserveOutcome> => {
      const now = clock.now();
      // Holding the day row lock serializes every reservation, so the
      // in-flight count and the fit check below cannot race.
      const { day, month } = await ensureAndLockPeriods(tx, now, config);

      const [inFlight] = await tx
        .select({ n: count() })
        .from(providerRequests)
        .where(
          and(
            eq(providerRequests.status, "reserved"),
            gte(providerRequests.createdAt, new Date(now.getTime() - IN_FLIGHT_WINDOW_MS)),
          ),
        );
      if ((inFlight?.n ?? 0) >= config.runtime.maxConcurrentPaidCalls) return { kind: "busy" };

      if (estimate > 0) {
        for (const row of [day, month]) {
          if (row.spentMicros + row.reservedMicros + estimate > row.limitMicros) {
            return {
              kind: "exhausted",
              message: `The ${row.kind} budget cannot fit this call.`,
            };
          }
        }
      }

      const [request] = await tx
        .insert(providerRequests)
        .values({
          actionKey: meta.actionKey,
          purpose: meta.purpose,
          origin: meta.origin,
          provider: meta.provider,
          model: meta.model,
          status: "reserved",
          estimatedInputTokens: inputTokens,
          maxOutputTokens: meta.maxOutputTokens,
          estimatedMicros: estimate,
          createdAt: now,
        })
        .returning({ id: providerRequests.id });
      const [reservation] = await tx
        .insert(costReservations)
        .values({
          providerRequestId: request!.id,
          dayPeriodId: day.id,
          monthPeriodId: month.id,
          amountMicros: estimate,
          status: "open",
          createdAt: now,
        })
        .returning({ id: costReservations.id });
      await tx
        .update(budgetPeriods)
        .set({
          reservedMicros: sql`${budgetPeriods.reservedMicros} + ${estimate}`,
          updatedAt: now,
        })
        .where(inArray(budgetPeriods.id, [day.id, month.id]));
      return {
        kind: "reserved",
        value: { reservationId: reservation!.id, estimateMicros: estimate },
      };
    });
  }

  private async recordRejected(
    meta: CallMeta,
    inputTokens: number,
    estimate: number,
    reason: RefusalReason,
  ): Promise<void> {
    const now = this.deps.clock.now();
    await this.deps.db.insert(providerRequests).values({
      actionKey: meta.actionKey,
      purpose: meta.purpose,
      origin: meta.origin,
      provider: meta.provider,
      model: meta.model,
      status: "rejected",
      rejectReason: reason,
      estimatedInputTokens: inputTokens,
      maxOutputTokens: meta.maxOutputTokens,
      estimatedMicros: estimate,
      createdAt: now,
      completedAt: now,
    });
  }
}

/** Rejects when the signal aborts, even if the provider ignores it. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    if (signal.aborted) onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function usageColumns(usage: Usage) {
  return {
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
  };
}

type RequestPatch = Partial<typeof providerRequests.$inferInsert>;

type Resolution =
  | { kind: "settle"; actualMicros: number; request: RequestPatch }
  | { kind: "release"; request: RequestPatch }
  | { kind: "ambiguous"; request: RequestPatch };

/**
 * Moves one reservation out of open (or ambiguous) in a single transaction,
 * locking the period rows in the fixed order. A reservation that is already
 * settled or released is left alone.
 */
async function resolveReservation(
  db: Db,
  now: Date,
  reservationId: string,
  resolution: Resolution,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [reservation] = await tx
      .select()
      .from(costReservations)
      .where(eq(costReservations.id, reservationId))
      .for("update");
    if (!reservation) return false;
    if (reservation.status === "settled" || reservation.status === "released") return false;
    if (resolution.kind === "ambiguous" && reservation.status === "ambiguous") return false;

    if (resolution.kind === "ambiguous") {
      await tx
        .update(costReservations)
        .set({ status: "ambiguous" })
        .where(eq(costReservations.id, reservationId));
    } else {
      await lockPeriods(tx, reservation.dayPeriodId, reservation.monthPeriodId);
      const periodIds = [reservation.dayPeriodId, reservation.monthPeriodId];
      const spentDelta = resolution.kind === "settle" ? resolution.actualMicros : 0;
      await tx
        .update(budgetPeriods)
        .set({
          reservedMicros: sql`${budgetPeriods.reservedMicros} - ${reservation.amountMicros}`,
          spentMicros: sql`${budgetPeriods.spentMicros} + ${spentDelta}`,
          updatedAt: now,
        })
        .where(inArray(budgetPeriods.id, periodIds));
      await tx
        .update(costReservations)
        .set({
          status: resolution.kind === "settle" ? "settled" : "released",
          actualMicros: resolution.kind === "settle" ? resolution.actualMicros : null,
          settledAt: now,
        })
        .where(eq(costReservations.id, reservationId));
    }
    await tx
      .update(providerRequests)
      .set({ ...resolution.request, completedAt: now })
      .where(eq(providerRequests.id, reservation.providerRequestId));
    return true;
  });
}

export interface ReconcileOptions {
  openAfterMs?: number;
  settleAmbiguousAfterMs?: number;
}

/** Retires reservations whose worker is gone, then settles old ambiguous ones conservatively. */
export async function reconcileReservations(
  db: Db,
  clock: Clock,
  options: ReconcileOptions = {},
): Promise<{ markedAmbiguous: number; settled: number }> {
  const openAfterMs = options.openAfterMs ?? 15 * 60_000;
  const settleAfterMs = options.settleAmbiguousAfterMs ?? 60 * 60_000;
  const now = clock.now();

  const stale = await db
    .select({ id: costReservations.id })
    .from(costReservations)
    .where(
      and(
        eq(costReservations.status, "open"),
        lt(costReservations.createdAt, new Date(now.getTime() - openAfterMs)),
      ),
    );
  let markedAmbiguous = 0;
  for (const row of stale) {
    const done = await resolveReservation(db, now, row.id, {
      kind: "ambiguous",
      request: { status: "ambiguous", error: "worker lost during call" },
    });
    if (done) markedAmbiguous++;
  }

  const old = await db
    .select({ id: costReservations.id, amount: costReservations.amountMicros })
    .from(costReservations)
    .where(
      and(
        eq(costReservations.status, "ambiguous"),
        lt(costReservations.createdAt, new Date(now.getTime() - settleAfterMs)),
      ),
    );
  let settled = 0;
  for (const row of old) {
    const done = await resolveReservation(db, now, row.id, {
      kind: "settle",
      actualMicros: row.amount,
      request: { status: "ambiguous", actualMicros: row.amount },
    });
    if (done) settled++;
  }
  return { markedAmbiguous, settled };
}

export interface PeriodStatus {
  start: Date;
  end: Date;
  limitMicros: number;
  spentMicros: number;
  reservedMicros: number;
  remainingMicros: number;
}

export interface BudgetStatus {
  day: PeriodStatus;
  month: PeriodStatus;
  remainingMicros: number;
  stage: BudgetStage;
  pausePaidActions: boolean;
  ambiguousCount: number;
  /** Twice the average estimate of the 20 newest non-rejected provider requests; 0 without history. */
  actionReserveMicros: number;
  forecast: { dayProjectedMicros: number | null; monthProjectedMicros: number | null };
}

const FORECAST_MIN_ELAPSED_MS = 30 * 60_000;
const RESERVE_SAMPLE_SIZE = 20;

/** Room that must remain for one more action: twice the recent average call estimate. */
async function actionReserveMicros(db: DbOrTx): Promise<number> {
  const recent = await db
    .select({ micros: providerRequests.estimatedMicros })
    .from(providerRequests)
    .where(ne(providerRequests.status, "rejected"))
    .orderBy(desc(providerRequests.createdAt))
    .limit(RESERVE_SAMPLE_SIZE);
  if (recent.length === 0) return 0;
  const total = recent.reduce((sum, row) => sum + row.micros, 0);
  return Math.ceil((2 * total) / recent.length);
}

export async function getBudgetStatus(
  db: DbOrTx,
  config: AgoraConfig,
  clock: Clock,
): Promise<BudgetStatus> {
  const now = clock.now();
  const windows = {
    day: {
      kind: "day" as const,
      start: utcDayStart(now),
      end: utcNextDayStart(now),
      limit: toMicros(config.budget.dailyVariableSpendLimit),
    },
    month: {
      kind: "month" as const,
      start: utcMonthStart(now),
      end: utcNextMonthStart(now),
      limit: toMicros(config.budget.monthlyVariableSpendLimit),
    },
  };
  const build = async (w: (typeof windows)[keyof typeof windows]): Promise<PeriodStatus> => {
    const [row] = await db
      .select()
      .from(budgetPeriods)
      .where(and(eq(budgetPeriods.kind, w.kind), eq(budgetPeriods.periodStart, w.start)));
    const spent = row?.spentMicros ?? 0;
    const reserved = row?.reservedMicros ?? 0;
    return {
      start: w.start,
      end: w.end,
      limitMicros: w.limit,
      spentMicros: spent,
      reservedMicros: reserved,
      remainingMicros: Math.max(0, w.limit - spent - reserved),
    };
  };
  const day = await build(windows.day);
  const month = await build(windows.month);
  const remainingMicros = Math.min(day.remainingMicros, month.remainingMicros);
  const reserve = await actionReserveMicros(db);
  const [ambiguous] = await db
    .select({ n: count() })
    .from(costReservations)
    .where(eq(costReservations.status, "ambiguous"));

  const project = (p: PeriodStatus): number | null => {
    const elapsed = now.getTime() - p.start.getTime();
    if (elapsed < FORECAST_MIN_ELAPSED_MS) return null;
    return Math.round(p.spentMicros / (elapsed / (p.end.getTime() - p.start.getTime())));
  };

  return {
    day,
    month,
    remainingMicros,
    stage: budgetStageFor({
      remainingMicros,
      dailyLimitMicros: day.limitMicros,
      pausePaidActions: config.runtime.pausePaidActions,
      actionReserveMicros: reserve,
    }),
    pausePaidActions: config.runtime.pausePaidActions,
    ambiguousCount: ambiguous?.n ?? 0,
    actionReserveMicros: reserve,
    forecast: { dayProjectedMicros: project(day), monthProjectedMicros: project(month) },
  };
}
