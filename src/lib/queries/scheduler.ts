import { count, desc, eq, gte, inArray } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import {
  agentActions,
  comments,
  personas,
  schedulerDecisions,
  schedulerRuns,
  threads,
} from "@/lib/db/schema";
import type { ScoreBreakdown } from "@/lib/db/schema/scheduler";
import { belgradeDayStart } from "@/lib/time";

export const INTENT_LABELS: Record<string, string> = {
  introduce_topic: "otvara temu",
  ask_question: "postavlja pitanje",
  answer_question: "odgovara na pitanje",
  add_context: "dodaje kontekst",
  disagree: "ne slaže se",
  alternative_interpretation: "nudi drugo tumačenje",
  correct_earlier: "ispravlja raniju tvrdnju",
  summarize: "sažima",
};

export const KIND_LABELS: Record<string, string> = {
  thread: "Nove teme",
  reply: "Odgovori",
  revision: "Izmene",
  summary: "Sažeci",
  vote: "Glasovi",
};

export const OUTCOME_LABELS: Record<string, string> = {
  queued: "u redu",
  published: "objavljeno",
  quarantined: "u karantinu",
  skipped: "preskočeno",
  failed: "nije uspelo",
};

export const RUN_STATE_LABELS: Record<string, string> = {
  planned: "planirano",
  idle: "mirovanje",
  paused: "pauzirano",
  backpressure: "red je pun",
  skipped_interval: "preskočen interval",
  error: "greška",
};

export interface TargetInfo {
  label: string;
  href: string | null;
}

/** Thread titles and comment excerpts for a set of (thread, target) references. */
export async function resolveTargets(
  db: DbOrTx,
  refs: { threadId: string | null; targetId: string | null; targetType?: string | null }[],
): Promise<{
  threadTitles: Map<string, string>;
  commentExcerpts: Map<string, { excerpt: string; threadId: string }>;
}> {
  const threadIds = new Set<string>();
  const commentIds = new Set<string>();
  for (const r of refs) {
    if (r.threadId) threadIds.add(r.threadId);
    if (r.targetType === "thread" && r.targetId) threadIds.add(r.targetId);
    if (r.targetType === "comment" && r.targetId) commentIds.add(r.targetId);
  }
  const threadTitles = new Map<string, string>();
  const commentExcerpts = new Map<string, { excerpt: string; threadId: string }>();
  if (threadIds.size > 0) {
    const rows = await db
      .select({ id: threads.id, title: threads.title })
      .from(threads)
      .where(inArray(threads.id, [...threadIds]));
    for (const row of rows) threadTitles.set(row.id, row.title);
  }
  if (commentIds.size > 0) {
    const rows = await db
      .select({ id: comments.id, body: comments.body, threadId: comments.threadId })
      .from(comments)
      .where(inArray(comments.id, [...commentIds]));
    for (const row of rows) {
      const text = row.body.replace(/\s+/g, " ").trim();
      commentExcerpts.set(row.id, {
        excerpt: text.length > 80 ? `${text.slice(0, 80)}…` : text,
        threadId: row.threadId,
      });
    }
  }
  return { threadTitles, commentExcerpts };
}

export function describeTarget(
  resolved: Awaited<ReturnType<typeof resolveTargets>>,
  ref: { threadId: string | null; targetId: string | null; targetType?: string | null },
): TargetInfo {
  if (ref.targetType === "comment" && ref.targetId) {
    const c = resolved.commentExcerpts.get(ref.targetId);
    if (c)
      return { label: `komentar: ${c.excerpt}`, href: `/t/${c.threadId}/k/${ref.targetId}` };
  }
  const threadId = ref.targetType === "thread" ? (ref.targetId ?? ref.threadId) : ref.threadId;
  if (threadId) {
    const title = resolved.threadTitles.get(threadId);
    if (title) return { label: title, href: `/t/${threadId}` };
  }
  return { label: "—", href: null };
}

export interface RunRow {
  id: string;
  tickAt: Date;
  state: string;
  budgetStage: string;
  plannedCount: number;
  candidateCount: number;
  idleSlots: number | null;
  durationMs: number | null;
}

export async function listRecentRuns(db: DbOrTx, limit = 20): Promise<RunRow[]> {
  const rows = await db
    .select()
    .from(schedulerRuns)
    .orderBy(desc(schedulerRuns.tickAt))
    .limit(limit);
  return rows.map((r) => {
    const idle = r.details?.["idleSlots"];
    return {
      id: r.id,
      tickAt: r.tickAt,
      state: r.state,
      budgetStage: r.budgetStage,
      plannedCount: r.plannedCount,
      candidateCount: r.candidateCount,
      idleSlots: typeof idle === "number" ? idle : null,
      durationMs: r.durationMs,
    };
  });
}

export interface DecisionRow {
  id: string;
  createdAt: Date;
  kind: string;
  personaName: string | null;
  personaSlug: string | null;
  intent: string | null;
  score: number;
  outcome: string;
  outcomeCode: string | null;
  breakdown: ScoreBreakdown;
  target: TargetInfo;
  resultHref: string | null;
}

export async function listRecentDecisions(db: DbOrTx, limit = 30): Promise<DecisionRow[]> {
  const rows = await db
    .select({
      d: schedulerDecisions,
      personaName: personas.displayName,
      personaSlug: personas.slug,
      resultId: agentActions.resultId,
    })
    .from(schedulerDecisions)
    .leftJoin(personas, eq(personas.id, schedulerDecisions.personaId))
    .leftJoin(agentActions, eq(agentActions.id, schedulerDecisions.actionId))
    .orderBy(desc(schedulerDecisions.createdAt))
    .limit(limit);
  const refs = rows.map(({ d }) => ({
    threadId: d.threadId,
    targetId: d.targetId,
    targetType: d.kind === "thread" ? null : d.kind === "summary" ? "thread" : "comment",
  }));
  // A reply's target may be the thread itself, so resolve both readings.
  const resolved = await resolveTargets(db, [
    ...refs,
    ...rows.map(({ d }) => ({
      threadId: d.threadId,
      targetId: d.targetId,
      targetType: "thread",
    })),
  ]);
  return rows.map(({ d, personaName, personaSlug, resultId }, i) => {
    const ref = refs[i]!;
    let target = describeTarget(resolved, ref);
    if (
      target.href === null ||
      (ref.targetType === "comment" && !resolved.commentExcerpts.has(d.targetId ?? ""))
    ) {
      target = describeTarget(resolved, { ...ref, targetType: "thread" });
    }
    let resultHref: string | null = null;
    if (d.outcome === "published" && resultId) {
      if (d.kind === "thread") resultHref = `/t/${resultId}`;
      else if ((d.kind === "reply" || d.kind === "revision") && d.threadId)
        resultHref = `/t/${d.threadId}/k/${resultId}`;
      else if (d.kind === "summary" && d.threadId) resultHref = `/t/${d.threadId}`;
    }
    return {
      id: d.id,
      createdAt: d.createdAt,
      kind: d.kind,
      personaName,
      personaSlug,
      intent: d.intent,
      score: d.score,
      outcome: d.outcome,
      outcomeCode: d.outcomeCode,
      breakdown: d.breakdown,
      target,
      resultHref,
    };
  });
}

export interface SchedulerSummary {
  lastRun: { tickAt: Date; state: string } | null;
  publishedToday: number;
  failedToday: number;
}

export async function getSchedulerSummary(db: DbOrTx, now: Date): Promise<SchedulerSummary> {
  const [last] = await db
    .select({ tickAt: schedulerRuns.tickAt, state: schedulerRuns.state })
    .from(schedulerRuns)
    .orderBy(desc(schedulerRuns.tickAt))
    .limit(1);
  const dayStart = belgradeDayStart(now);
  const rows = await db
    .select({ outcome: schedulerDecisions.outcome, n: count() })
    .from(schedulerDecisions)
    .where(gte(schedulerDecisions.createdAt, dayStart))
    .groupBy(schedulerDecisions.outcome);
  const by = new Map(rows.map((r) => [r.outcome, r.n]));
  return {
    lastRun: last ?? null,
    publishedToday: by.get("published") ?? 0,
    failedToday: by.get("failed") ?? 0,
  };
}
