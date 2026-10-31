import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ManualClock } from "@/lib/clock";
import type { AgoraConfig } from "@/lib/config/schema";
import {
  BudgetRefusedError,
  CostGateway,
  getBudgetStatus,
  reconcileReservations,
  type CallMeta,
} from "@/lib/costs/gateway";
import { meterProviders } from "@/lib/costs/metered";
import { SIMULATION_PRICE_TABLE } from "@/lib/costs/prices";
import { budgetPeriods, costReservations, providerRequests, threads } from "@/lib/db/schema";
import { moderateContent } from "@/lib/domain/moderation";
import { createThread } from "@/lib/domain/threads";
import { createProviders } from "@/lib/providers";
import {
  ProviderCallError,
  ProviderNotConfiguredError,
  ZERO_USAGE,
  type GenerationRequest,
} from "@/lib/providers/types";
import { makeContext, seedMinimal, SERBIAN_THREAD, testDb } from "./helpers";

const START = new Date("2026-09-10T10:00:00Z");
const MINUTE = 60_000;

// Payload "x" estimates 2,002 input tokens; with 1000 output tokens a Luna call
// reserves ceil(2002 * 0.2 + 1000 * 1.2) = 1601 micro-USD.
const EST = 1601;
const FULL_USAGE = { ...ZERO_USAGE, inputTokens: 2002, outputTokens: 1000 };

function meta(over: Partial<CallMeta> = {}): CallMeta {
  return {
    actionKey: "k",
    purpose: "generation",
    origin: "scheduler",
    provider: "openai",
    model: "gpt-5.6-luna",
    estimatePayload: "x",
    maxOutputTokens: 1000,
    ...over,
  };
}

function setup(
  limits: { day?: number; month?: number } = {},
  configure?: (c: AgoraConfig) => void,
) {
  const db = testDb();
  const clock = new ManualClock(START);
  const ctx = makeContext(db);
  ctx.config.budget.dailyVariableSpendLimit = limits.day ?? 1;
  ctx.config.budget.monthlyVariableSpendLimit = limits.month ?? 10;
  ctx.config.runtime.maxConcurrentPaidCalls = 4;
  configure?.(ctx.config);
  const gateway = new CostGateway({
    db,
    config: ctx.config,
    clock,
    prices: SIMULATION_PRICE_TABLE,
    busyWaitMs: 3000,
  });
  return { db, clock, ctx, gateway };
}

const ok =
  (usage = FULL_USAGE) =>
  async () => ({ usage });

async function period(kind: "day" | "month") {
  return testDb().select().from(budgetPeriods).where(eq(budgetPeriods.kind, kind));
}

describe("cost gateway", () => {
  it("settles at actual usage and records the request", async () => {
    const { db, gateway } = setup();
    await gateway.run(meta(), ok({ ...ZERO_USAGE, inputTokens: 1000, outputTokens: 100 }));
    const [day] = await period("day");
    expect(day?.reservedMicros).toBe(0);
    expect(day?.spentMicros).toBe(Math.ceil(1000 * 0.2 + 100 * 1.2));
    const [req] = await db.select().from(providerRequests);
    expect(req).toMatchObject({
      status: "succeeded",
      origin: "scheduler",
      purpose: "generation",
      estimatedMicros: EST,
      inputTokens: 1000,
      outputTokens: 100,
    });
    expect(req?.actualMicros).toBe(day?.spentMicros);
    expect(req?.completedAt).not.toBeNull();
    const [res] = await db.select().from(costReservations);
    expect(res?.status).toBe("settled");
  });

  it("releases the reservation on a definite non-billable failure", async () => {
    const { db, gateway } = setup();
    const error = new ProviderCallError("rate limited", "not_billed", true, { status: 429 });
    await expect(gateway.run(meta(), () => Promise.reject(error))).rejects.toBe(error);
    const [day] = await period("day");
    expect(day).toMatchObject({ reservedMicros: 0, spentMicros: 0 });
    const [req] = await db.select().from(providerRequests);
    expect(req?.status).toBe("failed");
    expect(req?.error).toContain("rate limited");
    const [res] = await db.select().from(costReservations);
    expect(res?.status).toBe("released");
  });

  it("settles a billed failure at the reported usage", async () => {
    const { db, gateway } = setup();
    const usage = { ...ZERO_USAGE, inputTokens: 500, outputTokens: 200 };
    const error = new ProviderCallError("incomplete", "billed", false, { usage });
    await expect(gateway.run(meta(), () => Promise.reject(error))).rejects.toBe(error);
    const [day] = await period("day");
    expect(day?.reservedMicros).toBe(0);
    expect(day?.spentMicros).toBe(Math.ceil(500 * 0.2 + 200 * 1.2));
    const [req] = await db.select().from(providerRequests);
    expect(req).toMatchObject({ status: "failed", outputTokens: 200 });
  });

  it("keeps an ambiguous failure reserved, then settles it conservatively", async () => {
    const { db, gateway, clock, ctx } = setup();
    await expect(
      gateway.run(meta(), () => Promise.reject(new Error("socket hang up"))),
    ).rejects.toThrow("socket hang up");
    let [day] = await period("day");
    expect(day).toMatchObject({ reservedMicros: EST, spentMicros: 0 });
    let [res] = await db.select().from(costReservations);
    expect(res?.status).toBe("ambiguous");
    expect((await getBudgetStatus(db, ctx.config, clock)).ambiguousCount).toBe(1);

    // Too early: nothing changes.
    clock.advance(30 * MINUTE);
    expect(await reconcileReservations(db, clock)).toEqual({ markedAmbiguous: 0, settled: 0 });

    clock.advance(31 * MINUTE);
    expect(await reconcileReservations(db, clock)).toEqual({ markedAmbiguous: 0, settled: 1 });
    [day] = await period("day");
    expect(day).toMatchObject({ reservedMicros: 0, spentMicros: EST });
    [res] = await db.select().from(costReservations);
    expect(res).toMatchObject({ status: "settled", actualMicros: EST });
    const [req] = await db.select().from(providerRequests);
    expect(req).toMatchObject({ status: "ambiguous", actualMicros: EST });
  });

  it("marks stale open reservations ambiguous, then settles them", async () => {
    const { db, gateway, clock } = setup();
    await gateway.run(meta(), ok());
    // Simulate a worker that died mid-call: put the reservation back to open.
    await db.update(costReservations).set({ status: "open", actualMicros: null });
    await db.update(providerRequests).set({ status: "reserved" });
    await db.update(budgetPeriods).set({ reservedMicros: EST, spentMicros: 0 });

    clock.advance(16 * MINUTE);
    expect(await reconcileReservations(db, clock)).toEqual({ markedAmbiguous: 1, settled: 0 });
    const [req] = await db.select().from(providerRequests);
    expect(req).toMatchObject({ status: "ambiguous", error: "worker lost during call" });
    const [res] = await db.select().from(costReservations);
    expect(res?.status).toBe("ambiguous");

    clock.advance(50 * MINUTE);
    expect(await reconcileReservations(db, clock)).toEqual({ markedAmbiguous: 0, settled: 1 });
    const [day] = await period("day");
    expect(day).toMatchObject({ reservedMicros: 0, spentMicros: EST });
  });

  it("refuses when the day row cannot fit the estimate", async () => {
    const { db, gateway } = setup({ day: (EST - 1) / 1e6 });
    let called = false;
    await expect(
      gateway.run(meta(), async () => {
        called = true;
        return { usage: ZERO_USAGE };
      }),
    ).rejects.toMatchObject({ reason: "budget_exhausted" });
    expect(called).toBe(false);
    const [req] = await db.select().from(providerRequests);
    expect(req).toMatchObject({ status: "rejected", rejectReason: "budget_exhausted" });
    expect(await db.select().from(costReservations)).toHaveLength(0);
  });

  it("refuses by the month row when it is the lower allowance", async () => {
    const { gateway } = setup({ day: 1, month: (EST - 1) / 1e6 });
    await expect(gateway.run(meta(), ok())).rejects.toMatchObject({
      reason: "budget_exhausted",
      message: expect.stringContaining("month"),
    });
  });

  it("counts earlier spend against the limit", async () => {
    const { gateway } = setup({ day: (EST * 2 - 1) / 1e6 });
    await gateway.run(meta(), ok());
    await expect(gateway.run(meta(), ok())).rejects.toBeInstanceOf(BudgetRefusedError);
  });

  it("pausePaidActions refuses the scheduler and allows admin", async () => {
    const { db, gateway } = setup({}, (c) => {
      c.runtime.pausePaidActions = true;
    });
    await expect(gateway.run(meta({ origin: "scheduler" }), ok())).rejects.toMatchObject({
      reason: "paid_paused",
    });
    await gateway.run(meta({ origin: "admin" }), ok());
    const rows = await db.select().from(providerRequests);
    expect(rows.map((r) => r.status).sort()).toEqual(["rejected", "succeeded"]);
  });

  it("rejects a call with no price and records the row", async () => {
    const { db, gateway } = setup();
    await expect(
      gateway.run(meta({ provider: "unknown", model: "m" }), ok()),
    ).rejects.toMatchObject({ reason: "no_price" });
    const [req] = await db.select().from(providerRequests);
    expect(req).toMatchObject({ status: "rejected", rejectReason: "no_price" });
  });

  it("opens a new day row on rollover and keeps the month row", async () => {
    const { gateway, clock } = setup();
    await gateway.run(meta(), ok());
    clock.advance(24 * 60 * MINUTE);
    await gateway.run(meta(), ok());
    const days = await period("day");
    const months = await period("month");
    expect(days).toHaveLength(2);
    expect(months).toHaveLength(1);
    expect(months[0]?.spentMicros).toBe(EST * 2);
    expect(days.map((d) => d.spentMicros)).toEqual([EST, EST]);
  });

  it("updates stored limits to the current config", async () => {
    const { ctx, gateway } = setup();
    await gateway.run(meta(), ok());
    ctx.config.budget.dailyVariableSpendLimit = 0.5;
    await gateway.run(meta(), ok());
    const [day] = await period("day");
    expect(day?.limitMicros).toBe(500_000);
  });

  it("never lets spent plus reserved pass the limit under concurrency", async () => {
    const { db, gateway } = setup({ day: (EST * 5) / 1e6 }, (c) => {
      c.runtime.maxConcurrentPaidCalls = 12;
    });
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        gateway.run(meta({ actionKey: `c${i}` }), async () => {
          await new Promise((r) => setTimeout(r, 50));
          return { usage: FULL_USAGE };
        }),
      ),
    );
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    expect(succeeded).toBeLessThanOrEqual(5);
    expect(succeeded).toBe(5);
    const [day] = await period("day");
    expect(day!.spentMicros + day!.reservedMicros).toBeLessThanOrEqual(day!.limitMicros);
    expect(day?.spentMicros).toBe(EST * 5);
    const rejected = await db
      .select()
      .from(providerRequests)
      .where(eq(providerRequests.status, "rejected"));
    expect(rejected).toHaveLength(7);
  });

  it("respects maxConcurrentPaidCalls", async () => {
    const { gateway } = setup({}, (c) => {
      c.runtime.maxConcurrentPaidCalls = 2;
    });
    let inFlight = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        gateway.run(meta({ actionKey: `m${i}` }), async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 50));
          inFlight--;
          return { usage: FULL_USAGE };
        }),
      ),
    );
    expect(results).toHaveLength(5);
    expect(peak).toBe(2);
  });

  it("refuses with busy when no slot frees up in time", async () => {
    const { db, clock, ctx } = setup({}, (c) => {
      c.runtime.maxConcurrentPaidCalls = 1;
    });
    const gateway = new CostGateway({
      db,
      config: ctx.config,
      clock,
      prices: SIMULATION_PRICE_TABLE,
      busyWaitMs: 1200,
    });
    let release!: () => void;
    const held = gateway.run(
      meta(),
      () =>
        new Promise<{ usage: typeof FULL_USAGE }>(
          (resolve) => (release = () => resolve({ usage: FULL_USAGE })),
        ),
    );
    await new Promise((r) => setTimeout(r, 200));
    await expect(gateway.run(meta({ actionKey: "b" }), ok())).rejects.toMatchObject({
      reason: "busy",
    });
    release();
    await held;
  });

  it("treats a timed-out call as ambiguous", async () => {
    const { db, clock, ctx } = setup();
    const gateway = new CostGateway({
      db,
      config: ctx.config,
      clock,
      prices: SIMULATION_PRICE_TABLE,
      callTimeoutMs: 50,
    });
    await expect(
      gateway.run(meta(), () => new Promise<{ usage: typeof FULL_USAGE }>(() => {})),
    ).rejects.toThrow(/timed out/);
    const [res] = await db.select().from(costReservations);
    expect(res?.status).toBe("ambiguous");
    const [day] = await period("day");
    expect(day?.reservedMicros).toBe(EST);
  });

  it("reports budget status with a forecast", async () => {
    const { db, gateway, clock, ctx } = setup({ day: 0.01, month: 1 });
    clock.set(new Date("2026-09-10T00:10:00Z"));
    expect(
      (await getBudgetStatus(db, ctx.config, clock)).forecast.dayProjectedMicros,
    ).toBeNull();
    await gateway.run(meta(), ok());
    clock.advance(2 * 60 * MINUTE);
    const status = await getBudgetStatus(db, ctx.config, clock);
    expect(status.day.spentMicros).toBe(EST);
    expect(status.day.limitMicros).toBe(10_000);
    expect(status.remainingMicros).toBe(10_000 - EST);
    expect(status.stage).toBe("normal");
    expect(status.forecast.dayProjectedMicros).toBe(Math.round(EST / (130 / 1440)));
    expect(status.forecast.monthProjectedMicros).not.toBeNull();
  });
});

const GEN_REQUEST: GenerationRequest = {
  purpose: "thread",
  persona: {
    id: "p",
    slug: "p",
    displayName: "P",
    style: "kratko",
    scriptPreference: "Latin",
    vocabularyNotes: "",
    interests: ["kuhinja"],
  },
  intent: "introduce_topic",
  context: { community: { slug: "kuhinja", name: "Kuhinja", description: "Recepti." } },
  seed: "seed-1",
  maxOutputTokens: 800,
  maxBodyCharacters: 1500,
};

describe("action reserve and the paused stage", () => {
  it("has no reserve without history", async () => {
    const { db, clock, ctx } = setup({ day: 0.01 });
    const status = await getBudgetStatus(db, ctx.config, clock);
    expect(status.actionReserveMicros).toBe(0);
    expect(status.stage).toBe("normal");
  });

  it("pauses when the remainder is below twice the recent call estimate, ignoring rejected rows", async () => {
    // A 10,000 micro-USD day; each call estimates 1,601 and settles at 1,200.
    const { db, clock, ctx, gateway } = setup({ day: 0.01 });
    const usage = { ...ZERO_USAGE, inputTokens: 0, outputTokens: 1000 };
    for (let i = 0; i < 6; i++) await gateway.run(meta({ actionKey: "r" + i }), ok(usage));
    const status = await getBudgetStatus(db, ctx.config, clock);
    // 2,800 remain (28 %): "reduced" by share alone, but not enough for two more calls.
    expect(status.remainingMicros).toBe(2800);
    expect(status.actionReserveMicros).toBe(2 * EST);
    expect(status.stage).toBe("paused");

    // A refused call writes a rejected row with a huge estimate; it must not move the reserve.
    await expect(
      gateway.run(meta({ actionKey: "big", maxOutputTokens: 100_000 }), ok(usage)),
    ).rejects.toBeInstanceOf(BudgetRefusedError);
    expect((await getBudgetStatus(db, ctx.config, clock)).actionReserveMicros).toBe(2 * EST);
  });
});

describe("metered providers", () => {
  it("writes rows with the right origin and purpose", async () => {
    const { db, gateway } = setup();
    const metered = meterProviders(createProviders("mock"), gateway, "eval");
    expect(metered.generation.name).toBe("mock");
    await metered.generation.generate(GEN_REQUEST);
    await metered.generation.generate({
      ...GEN_REQUEST,
      repair: { previousBody: "x", codes: ["empty_body"] },
    });
    await metered.search.search({ query: "ajvar", maxResults: 2, seed: "s" });
    const rows = await db.select().from(providerRequests);
    expect(rows.map((r) => [r.purpose, r.origin, r.status]).sort()).toEqual([
      ["generation", "eval", "succeeded"],
      ["repair", "eval", "succeeded"],
      ["search", "eval", "succeeded"],
    ]);
    expect(rows.find((r) => r.purpose === "generation")?.actionKey).toBe("seed-1");
  });
});

describe("metered providers that are not configured", () => {
  it("surface ProviderNotConfiguredError and write no gateway rows", async () => {
    const { db, gateway } = setup();
    const metered = meterProviders(createProviders("live"), gateway, "scheduler");
    await expect(metered.generation.generate(GEN_REQUEST)).rejects.toBeInstanceOf(
      ProviderNotConfiguredError,
    );
    await expect(
      metered.validation.validate({
        kind: "comment",
        body: "x",
        context: { communitySlug: "a", communityName: "A", inheritsTopic: true },
        heuristics: {} as never,
        evidence: [],
        claimedEvidenceIds: [],
        seed: "s",
        maxOutputTokens: 100,
      }),
    ).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    expect(await db.select().from(providerRequests)).toHaveLength(0);
  });
});

describe("moderation with a soft code", () => {
  it("still hides when the validator could not run next to a soft code", async () => {
    const db = testDb();
    const ctx = makeContext(db);
    const fx = await seedMinimal(ctx);
    const created = await createThread(
      {
        actor: fx.personaA,
        actionKey: "test:thread:soft",
        communitySlug: fx.communitySlug,
        ...SERBIAN_THREAD,
      },
      ctx,
    );
    if (created.status !== "published") throw new Error("thread not published");
    ctx.providers = {
      ...ctx.providers,
      validation: {
        name: "down",
        model: "none",
        configured: true,
        validate: async () => {
          throw new Error("provider down");
        },
      },
    };
    const hidden = await moderateContent(
      {
        actor: { kind: "admin", accountId: fx.personaA.accountId },
        targetType: "thread",
        targetId: created.id,
        action: "hide",
        explanation:
          "Sakriveno radi provere navedenih izvora, jer tekst sadrži slovo ы kojem ovde nije mesto.",
      },
      ctx,
    );
    expect(hidden?.details).toMatchObject({
      gateCodes: expect.arrayContaining(["foreign_cyrillic_letters", "validator_unavailable"]),
    });
  });
});

describe("moderation under a refused budget", () => {
  it("lets a hide proceed when only the validator was refused, but not a restore", async () => {
    const db = testDb();
    const plain = makeContext(db);
    const fx = await seedMinimal(plain);
    const created = await createThread(
      {
        actor: fx.personaA,
        actionKey: "test:thread:mod",
        communitySlug: fx.communitySlug,
        ...SERBIAN_THREAD,
      },
      plain,
    );
    if (created.status !== "published") throw new Error("thread not published");

    const metered = makeContext(db);
    metered.config.budget.dailyVariableSpendLimit = 0.0000001;
    metered.providers = meterProviders(
      createProviders("mock"),
      new CostGateway({
        db,
        config: metered.config,
        clock: new ManualClock(START),
        prices: SIMULATION_PRICE_TABLE,
      }),
      "admin",
    );
    const admin = { kind: "admin" as const, accountId: fx.personaA.accountId };

    const hidden = await moderateContent(
      {
        actor: admin,
        targetType: "thread",
        targetId: created.id,
        action: "hide",
        explanation: "Sakriveno radi provere navedenih izvora.",
      },
      metered,
    );
    expect(hidden?.details).toEqual({ gateCodes: ["validator_budget_refused"] });
    const [thread] = await db.select().from(threads).where(eq(threads.id, created.id));
    expect(thread?.status).toBe("hidden");

    await expect(
      moderateContent(
        {
          actor: admin,
          targetType: "thread",
          targetId: created.id,
          action: "restore",
          explanation: "Izvori su provereni, tema je vraćena.",
        },
        metered,
      ),
    ).rejects.toMatchObject({ code: "gate_quarantined" });
  });
});
