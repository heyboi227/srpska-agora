import { randomUUID } from "node:crypto";
import { eq, max, sql } from "drizzle-orm";
import type { AgoraConfig } from "@/lib/config/schema";
import { getBudgetStatus, type BudgetStage } from "@/lib/costs";
import type { Db } from "@/lib/db/client";
import { schedulerDecisions, schedulerRuns, type ScoreBreakdown } from "@/lib/db/schema";
import type { Clock } from "@/lib/clock";
import {
  jobOptionsFor,
  type ActionJobPayload,
  type ActionKind,
  type JobQueue,
} from "@/lib/jobs/types";
import type { Intent } from "@/lib/providers/types";
import { SeededRandom } from "@/lib/random";
import { buildCandidates, dueSummaryThreads, finalizeIntent } from "./candidates";
import { emptyCounts, periodSeconds, planSlots } from "./pacing";
import { chooseAmong, scoreCandidates, type ScoredCandidate } from "./scoring";
import { applyPick, loadSnapshot, type SchedulerSnapshot } from "./snapshot";
import { FILL_ORDER } from "./weights";

export interface SchedulerDeps {
  db: Db;
  config: AgoraConfig;
  clock: Clock;
  /** Null only for previews. */
  queue: JobQueue | null;
}

export interface PlannedDecision {
  decisionId: string | null;
  kind: ActionKind;
  actionKey: string;
  personaId: string | null;
  personaName: string | null;
  communityId: string | null;
  threadId: string | null;
  targetId: string | null;
  targetType: "thread" | "comment" | null;
  intent: Intent | null;
  voteValue: 1 | -1 | null;
  topicHint: string | null;
  relatedCommentId: string | null;
  score: number;
  probability: number;
  breakdown: ScoreBreakdown;
  startAfter: Date;
  notAfter: Date;
  jobId: string | null;
}

export interface TickResult {
  state: "planned" | "idle" | "paused" | "backpressure" | "skipped_interval";
  runId: string | null;
  stage: BudgetStage;
  slots: Record<ActionKind, { expected: number; drawn: number }>;
  decisions: PlannedDecision[];
  idleSlots: number;
  candidateCount: number;
}

export interface PreviewResult {
  stage: BudgetStage;
  slots: Record<ActionKind, { expected: number }>;
  /** Top five by score per kind; nothing is drawn. */
  topCandidates: Record<ActionKind, PlannedDecision[]>;
}

const KINDS: readonly ActionKind[] = ["thread", "reply", "revision", "summary", "vote"];
const PREVIEW_TOP = 5;

function noSlots(): TickResult["slots"] {
  return Object.fromEntries(
    KINDS.map((k) => [k, { expected: 0, drawn: 0 }]),
  ) as TickResult["slots"];
}

function toPlanned(
  c: ScoredCandidate,
  snap: SchedulerSnapshot,
  config: AgoraConfig,
  actionKey: string,
  probability: number,
  rng: SeededRandom,
  withJitter: boolean,
): PlannedDecision {
  const persona = c.personaId
    ? (snap.personas.find((p) => p.id === c.personaId) ?? null)
    : null;
  const { intent, topicHint } = finalizeIntent(c, persona, rng);
  const jitter = withJitter ? rng.int(0, config.scheduler.jitterSeconds) : 0;
  return {
    decisionId: null,
    kind: c.kind,
    actionKey,
    personaId: c.personaId,
    personaName: persona?.displayName ?? null,
    communityId: c.communityId,
    threadId: c.threadId,
    targetId: c.targetId,
    targetType: c.targetType,
    intent,
    voteValue: c.voteValue,
    topicHint,
    relatedCommentId: c.relatedCommentId,
    score: c.score,
    probability,
    breakdown: c.breakdown,
    startAfter: new Date(snap.now.getTime() + jitter * 1000),
    notAfter: new Date(snap.now.getTime() + config.scheduler.jobFreshnessMinutes * 60_000),
    jobId: null,
  };
}

async function writeRun(
  db: Db,
  now: Date,
  state: TickResult["state"],
  stage: BudgetStage,
  details: Record<string, unknown>,
): Promise<string> {
  const [row] = await db
    .insert(schedulerRuns)
    .values({ tickAt: now, createdAt: now, state, budgetStage: stage, details })
    .returning({ id: schedulerRuns.id });
  if (!row) throw new Error("scheduler_runs insert returned no row");
  return row.id;
}

/** One scheduler tick: decide, record, enqueue. It never writes forum content itself. */
export async function runSchedulerTick(deps: SchedulerDeps): Promise<TickResult> {
  const { db, config, clock, queue } = deps;
  if (!queue) throw new Error("runSchedulerTick needs a job queue");
  const started = performance.now();
  const now = clock.now();
  const period = periodSeconds(config);
  const base = { decisions: [], idleSlots: 0, candidateCount: 0, slots: noSlots() };

  // 1. Interval guard: pg-boss may deliver a tick twice, or a worker may restart mid-minute.
  // Only a run less than half a period ago counts as a duplicate; a jittered tick that
  // arrives a few seconds early (55 s after the last one) still runs.
  const [latest] = await db.select({ at: max(schedulerRuns.tickAt) }).from(schedulerRuns);
  if (latest?.at && now.getTime() - latest.at.getTime() < (period * 1000) / 2) {
    const status = await getBudgetStatus(db, config, clock);
    return { ...base, state: "skipped_interval", runId: null, stage: status.stage };
  }

  const status = await getBudgetStatus(db, config, clock);
  const stage = status.stage;

  // 2. Paused forum.
  if (config.runtime.pauseAllActions) {
    const runId = await writeRun(db, now, "paused", stage, { reason: "pauseAllActions" });
    return { ...base, state: "paused", runId, stage };
  }

  // 3. Back-pressure: too much work already waiting.
  const pending = await queue.pendingCount();
  if (pending >= config.runtime.maxPendingJobs) {
    const runId = await writeRun(db, now, "backpressure", stage, {
      pendingJobs: pending,
      maxPendingJobs: config.runtime.maxPendingJobs,
    });
    return { ...base, state: "backpressure", runId, stage };
  }

  // 4-5. Snapshot.
  const snapStart = performance.now();
  const snap = await loadSnapshot(db, config, now);
  const snapMs = performance.now() - snapStart;

  // 6. Slots.
  const planStart = performance.now();
  const plans = planSlots({
    hour: snap.hour,
    scheduler: config.scheduler,
    content: config.content,
    periodSec: period,
    usedToday: snap.usedToday,
    plannedLastHour: snap.plannedLastHour,
    dueSummaries: dueSummaryThreads(snap, config).length,
    maxActionsPerTick: config.scheduler.maxActionsPerTick,
    seed: `${now.toISOString()}:slots`,
  });

  // 7. Fill slots, updating the snapshot after every pick so later slots see it.
  let version = 0;
  const cache = new Map<ActionKind, { version: number; ranked: ScoredCandidate[] }>();
  const rankedFor = (kind: ActionKind): ScoredCandidate[] => {
    const hit = cache.get(kind);
    if (hit && hit.version === version) return hit.ranked;
    const ranked = scoreCandidates(buildCandidates(kind, snap, config), stage);
    cache.set(kind, { version, ranked });
    return ranked;
  };

  const decisions: PlannedDecision[] = [];
  // Content versions as known at planning time, before later picks change the snapshot.
  const versions = new Map<string, ActionJobPayload["contentVersion"]>();
  let idleSlots = 0;
  let candidateCount = 0;
  for (const kind of FILL_ORDER) {
    const count = plans[kind].drawn;
    if (count > 0) candidateCount += rankedFor(kind).length;
    for (let slot = 0; slot < count; slot += 1) {
      const rng = new SeededRandom(`${now.toISOString()}:${kind}:${slot}`);
      const choice = chooseAmong(rankedFor(kind), rng);
      if (!choice.chosen) {
        idleSlots += 1;
        continue;
      }
      const actionKey = `sched:${kind}:${now.toISOString()}:${slot}`;
      const planned = toPlanned(
        choice.chosen,
        snap,
        config,
        actionKey,
        choice.probability,
        rng,
        true,
      );
      decisions.push(planned);
      versions.set(actionKey, choice.chosen.contentVersion);
      applyPick(snap, planned);
      version += 1;
    }
  }
  const planMs = performance.now() - planStart;

  // 8. Persist in one transaction behind an advisory lock.
  const persistStart = performance.now();
  const details: Record<string, unknown> = {
    periodSeconds: period,
    slots: Object.fromEntries(
      KINDS.map((k) => [
        k,
        { expected: plans[k].expected, capped: plans[k].capped, drawn: plans[k].drawn },
      ]),
    ),
    idleSlots,
    pendingJobs: pending,
    snapshot: snap.sizes,
    timingsMs: { snapshot: Math.round(snapMs), plan: Math.round(planMs) },
  };
  const ids = decisions.map(() => randomUUID());
  const runId = await db.transaction(async (tx) => {
    const lock = await tx.execute<{ ok: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtext('agora:scheduler')) as ok`,
    );
    // Another worker holds the lock: it is ticking right now.
    if (!lock.rows[0]?.ok) return null;
    // Another worker may have finished a tick between our interval check and the lock.
    const [recent] = await tx.select({ at: max(schedulerRuns.tickAt) }).from(schedulerRuns);
    if (recent?.at && now.getTime() - recent.at.getTime() < (period - 5) * 1000) return null;

    const [run] = await tx
      .insert(schedulerRuns)
      .values({
        tickAt: now,
        createdAt: now,
        state: decisions.length > 0 ? "planned" : "idle",
        budgetStage: stage,
        plannedCount: decisions.length,
        candidateCount,
        details: {
          ...details,
          timingsMs: {
            snapshot: Math.round(snapMs),
            plan: Math.round(planMs),
            persistStart: Math.round(performance.now() - persistStart),
          },
        },
        durationMs: Math.round(performance.now() - started),
      })
      .returning({ id: schedulerRuns.id });
    if (!run) throw new Error("scheduler_runs insert returned no row");
    if (decisions.length > 0) {
      await tx.insert(schedulerDecisions).values(
        decisions.map((d, i) => ({
          id: ids[i] as string,
          runId: run.id,
          kind: d.kind,
          actionKey: d.actionKey,
          personaId: d.personaId,
          communityId: d.communityId,
          threadId: d.threadId,
          targetId: d.targetId,
          intent: d.intent,
          score: d.score,
          probability: d.probability,
          breakdown: d.breakdown,
          outcome: "queued" as const,
          notAfter: d.notAfter,
          createdAt: now,
        })),
      );
    }
    return run.id;
  });

  const slots = Object.fromEntries(
    KINDS.map((k) => [k, { expected: plans[k].expected, drawn: plans[k].drawn }]),
  ) as TickResult["slots"];

  if (runId === null) {
    return { ...base, state: "skipped_interval", runId: null, stage, slots };
  }

  // After the commit: send the jobs. The singleton key makes a re-send harmless.
  for (const [i, d] of decisions.entries()) {
    d.decisionId = ids[i] ?? null;
    const payload = payloadFor(d, now, versions.get(d.actionKey) ?? {});
    try {
      const jobId = await queue.send(
        d.kind,
        payload,
        jobOptionsFor(d.kind, config, d.actionKey, d.startAfter),
      );
      if (jobId === null) {
        await db
          .update(schedulerDecisions)
          .set({ outcome: "skipped", outcomeCode: "duplicate", completedAt: now })
          .where(eq(schedulerDecisions.id, payload.decisionId));
      } else {
        d.jobId = jobId;
        await db
          .update(schedulerDecisions)
          .set({ jobId })
          .where(eq(schedulerDecisions.id, payload.decisionId));
      }
    } catch {
      await db
        .update(schedulerDecisions)
        .set({ outcome: "failed", outcomeCode: "enqueue_error", completedAt: now })
        .where(eq(schedulerDecisions.id, payload.decisionId));
    }
  }

  return {
    state: decisions.length > 0 ? "planned" : "idle",
    runId,
    stage,
    slots,
    decisions,
    idleSlots,
    candidateCount,
  };
}

/** The content versions are those at planning time; the job re-checks them before acting. */
function payloadFor(
  d: PlannedDecision,
  now: Date,
  contentVersion: ActionJobPayload["contentVersion"],
): ActionJobPayload {
  return {
    decisionId: d.decisionId ?? "",
    actionKey: d.actionKey,
    kind: d.kind,
    personaId: d.personaId,
    communityId: d.communityId,
    threadId: d.threadId,
    targetId: d.targetId,
    targetType: d.targetType,
    intent: d.intent,
    voteValue: d.voteValue,
    topicHint: d.topicHint,
    relatedCommentId: d.relatedCommentId,
    contentVersion,
    plannedAt: now.toISOString(),
    notAfter: d.notAfter.toISOString(),
  };
}

/** Read-only dry run: expected slots and the five best candidates per kind, with full breakdowns. */
export async function previewSchedulerTick(deps: SchedulerDeps): Promise<PreviewResult> {
  const { db, config, clock } = deps;
  const now = clock.now();
  const status = await getBudgetStatus(db, config, clock);
  const snap = await loadSnapshot(db, config, now);
  const plans = planSlots({
    hour: snap.hour,
    scheduler: config.scheduler,
    content: config.content,
    periodSec: periodSeconds(config),
    usedToday: emptyCounts(),
    plannedLastHour: emptyCounts(),
    dueSummaries: dueSummaryThreads(snap, config).length,
    maxActionsPerTick: config.scheduler.maxActionsPerTick,
    seed: `${now.toISOString()}:preview-slots`,
  });
  const slots = {} as PreviewResult["slots"];
  const topCandidates = {} as PreviewResult["topCandidates"];
  for (const kind of KINDS) {
    slots[kind] = { expected: plans[kind].expected };
    const ranked = scoreCandidates(buildCandidates(kind, snap, config), status.stage);
    const total = ranked.reduce((acc, c) => acc + c.score, 0);
    topCandidates[kind] = ranked.slice(0, PREVIEW_TOP).map((c, i) => {
      const rng = new SeededRandom(`${now.toISOString()}:preview:${c.sortKey}`);
      return toPlanned(
        c,
        snap,
        config,
        `preview:${kind}:${i}`,
        total > 0 ? c.score / total : 0,
        rng,
        false,
      );
    });
  }
  return { stage: status.stage, slots, topCandidates };
}
