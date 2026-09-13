import { eq, sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import { agentActions } from "@/lib/db/schema";
import type { GateReport } from "@/lib/gates/publication-gate";

/**
 * Action records give every content operation a stable key and a recorded
 * outcome. A retried job or a replayed backup finds the earlier row and
 * returns its result instead of publishing again.
 */

export type ActionRow = typeof agentActions.$inferSelect;
export type ActionType = ActionRow["actionType"];
export type ActionStatus = ActionRow["status"];

export interface ActionSpec {
  actionKey: string;
  actionType: ActionType;
  personaId?: string | null;
  actorAccountId?: string | null;
  communityId?: string | null;
  threadId?: string | null;
  targetId?: string | null;
  intent?: string | null;
  payload: Record<string, unknown>;
}

export type ActionResult =
  | { status: "published"; id: string; actionId: string; replayed: boolean }
  | {
      status: "quarantined";
      actionId: string;
      codes: string[];
      replayed: boolean;
      report: GateReport | null;
    };

export const TERMINAL_STATUSES: ReadonlySet<ActionStatus> = new Set([
  "published",
  "rejected",
  "quarantined",
]);

export function isTerminal(status: ActionStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Inserts the action as "proposed", or bumps the attempt counter when a
 * non-terminal row already exists. Returns the row and whether it pre-existed.
 */
export async function beginAction(
  db: DbOrTx,
  spec: ActionSpec,
): Promise<{ row: ActionRow; existing: boolean }> {
  const inserted = await db
    .insert(agentActions)
    .values({
      actionKey: spec.actionKey,
      actionType: spec.actionType,
      personaId: spec.personaId ?? null,
      actorAccountId: spec.actorAccountId ?? null,
      communityId: spec.communityId ?? null,
      threadId: spec.threadId ?? null,
      targetId: spec.targetId ?? null,
      intent: spec.intent ?? null,
      payload: spec.payload,
      status: "proposed",
    })
    .onConflictDoNothing({ target: agentActions.actionKey })
    .returning();
  const row = inserted[0];
  if (row) return { row, existing: false };

  const found = await db
    .select()
    .from(agentActions)
    .where(eq(agentActions.actionKey, spec.actionKey))
    .limit(1);
  const existing = found[0];
  if (!existing)
    throw new Error(`Action ${spec.actionKey} vanished between insert and select.`);
  if (!isTerminal(existing.status)) {
    const bumped = await db
      .update(agentActions)
      .set({ attempt: sql`${agentActions.attempt} + 1`, error: null })
      .where(eq(agentActions.id, existing.id))
      .returning();
    return { row: bumped[0] ?? existing, existing: true };
  }
  return { row: existing, existing: true };
}

/** Re-reads an action inside a transaction with a row lock so two workers cannot both publish. */
export async function lockAction(tx: DbOrTx, actionId: string): Promise<ActionRow> {
  const rows = await tx
    .select()
    .from(agentActions)
    .where(eq(agentActions.id, actionId))
    .for("update");
  const row = rows[0];
  if (!row) throw new Error(`Action ${actionId} not found while locking.`);
  return row;
}

export async function finishAction(
  tx: DbOrTx,
  actionId: string,
  patch: {
    status: ActionStatus;
    decisionCodes?: string[];
    gateReport?: Record<string, unknown> | null;
    resultId?: string | null;
    threadId?: string | null;
    error?: string | null;
  },
  now: Date = new Date(),
): Promise<void> {
  await tx
    .update(agentActions)
    .set({
      status: patch.status,
      decisionCodes: patch.decisionCodes ?? [],
      gateReport: patch.gateReport ?? null,
      resultId: patch.resultId ?? null,
      ...(patch.threadId !== undefined ? { threadId: patch.threadId } : {}),
      error: patch.error ?? null,
      completedAt: now,
    })
    .where(eq(agentActions.id, actionId));
}

/** Converts a terminal action row into the result a caller would have received originally. */
export function replayResult(row: ActionRow): ActionResult | null {
  if (row.status === "published" && row.resultId) {
    return { status: "published", id: row.resultId, actionId: row.id, replayed: true };
  }
  if (row.status === "quarantined" || row.status === "rejected") {
    return {
      status: "quarantined",
      actionId: row.id,
      codes: row.decisionCodes,
      replayed: true,
      report: (row.gateReport as unknown as GateReport | null) ?? null,
    };
  }
  return null;
}

/** Serialisable subset of a gate report for the action row. */
export function gateReportForStorage(report: GateReport): Record<string, unknown> {
  return {
    outcome: report.outcome,
    codes: report.codes,
    script: report.script,
    language: {
      outcome: report.language.outcome,
      confidence: report.language.confidence,
      codes: report.language.codes,
      tokens: report.language.tokens,
      serbianHits: report.language.serbianHits,
      englishHits: report.language.englishHits,
      regionalHits: report.language.regionalHits,
      script: report.language.script,
    },
    topical: report.topical,
    validator: report.validator
      ? {
          verdict: report.validator.verdict,
          reasons: report.validator.reasons,
          explanation: report.validator.explanation,
          provider: report.validator.provider,
          model: report.validator.model,
          usage: report.validator.usage,
        }
      : null,
    limits: report.limits,
  };
}
