import type { BudgetStage } from "@/lib/costs";
import type { ActionKind } from "@/lib/jobs/types";
import { burstLimit, dailyMaxFor, hourlyExpected } from "@/lib/scheduler/pacing";
import {
  belgradeDayKey,
  belgradeHour,
  isNightHour,
  utcDayStart,
  utcNextDayStart,
} from "@/lib/time";
import type { Scenario } from "./scenario";

/** Plain facts read from the database after a run; the checks below are pure over them. */

export interface DecisionFact {
  id: string;
  kind: ActionKind;
  personaId: string | null;
  threadId: string | null;
  outcome: "queued" | "published" | "quarantined" | "skipped" | "failed";
  code: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface ContentFact {
  id: string;
  isThread: boolean;
  threadId: string;
  parentId: string | null;
  authorId: string;
  communityId: string | null;
  createdAt: Date;
}

export interface PersonaFact {
  id: string;
  name: string;
  maxContentActionsPerDay: number;
  replyCooldownMinutes: number;
}

export interface RunFact {
  tickAt: Date;
  state: string;
  stage: BudgetStage;
}

export interface PeriodFact {
  kind: "day" | "month";
  start: Date;
  limitMicros: number;
  spentMicros: number;
  reservedMicros: number;
}

export interface CleanupSummary {
  /** How many times each cleanup ran, and the summed counts it reported. */
  runs: Record<string, number>;
  totals: Record<string, Record<string, number>>;
  /** Largest memory count of any persona right after each memory cleanup. */
  maxMemoriesAfterCleanup: number[];
}

export interface RetentionState {
  expiredSessionsLeft: number;
  validSessionsLeft: number;
  oldLoginAttemptsLeft: number;
  expiredMemoriesLeft: number;
}

export interface DuplicateDelivery {
  jobId: string;
  outcome: string;
  code: string | null;
  contentBefore: number;
  contentAfter: number;
  decisionOutcomeBefore: string;
  decisionOutcomeAfter: string;
}

export interface EvalInput {
  scenario: Scenario;
  end: Date;
  personas: PersonaFact[];
  communityCount: number;
  decisions: DecisionFact[];
  /** Every published thread and comment, seed content included. */
  content: ContentFact[];
  runs: RunFact[];
  periods: PeriodFact[];
  /** Threads, comments, votes and summaries created inside the pause window. */
  rowsCreatedInPause: number;
  /** When the pause really took effect (the first tick with queued work) and ended. */
  pauseWindow: { from: Date; to: Date } | null;
  /** When the worker really died (the first tick with queued work) and returned. */
  outageWindow: { from: Date; to: Date } | null;
  queue: { maxPending: number; deadLetters: number; retries: number };
  scriptedFailures: number;
  duplicate: DuplicateDelivery | null;
  cleanup: CleanupSummary;
  retention: RetentionState;
  duplicateActionKeys: number;
  publishedThreadsNew: number;
  publishedCommentsNew: number;
  /** Paid repair requests, the action keys they belong to, and keys with more than one. */
  repairCalls: number;
  repairKeys: number;
  repairKeysOverLimit: number;
  /** Quarantined decisions, and those whose action has published content or a result id. */
  quarantinedDecisions: number;
  quarantinedWithContent: number;
}

export type CheckStatus = "pass" | "fail" | "not_evaluated";

export interface CheckResult {
  id: number;
  name: string;
  status: CheckStatus;
  detail: string;
  problems: string[];
}

const HOUR = 3_600_000;
const MINUTE = 60_000;
const STAGE_RANK: Record<BudgetStage, number> = {
  normal: 0,
  reduced: 1,
  minimal: 2,
  paused: 3,
};

export const stageRank = (stage: BudgetStage): number => STAGE_RANK[stage];

export function isExecuted(d: Pick<DecisionFact, "outcome">): boolean {
  return d.outcome === "published" || d.outcome === "quarantined";
}

export function groupCount<T>(
  items: readonly T[],
  key: (item: T) => string,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) out.set(key(item), (out.get(key(item)) ?? 0) + 1);
  return out;
}

/** Largest value of a count map divided by the sum; 0 for an empty map. */
export function topShare(counts: ReadonlyMap<string, number>): number {
  let total = 0;
  let top = 0;
  for (const n of counts.values()) {
    total += n;
    top = Math.max(top, n);
  }
  return total === 0 ? 0 : top / total;
}

/**
 * Length of the alternating chain A, B, A, B... that ends at `commentId`: the
 * comment's author and its parent's author differ, and authors keep alternating
 * up the parent links. A top-level comment has a chain of 1.
 */
export function alternatingChainLength(
  commentId: string,
  byId: ReadonlyMap<string, Pick<ContentFact, "authorId" | "parentId">>,
): number {
  const first = byId.get(commentId);
  if (!first) return 0;
  const a = first.authorId;
  let b: string | null = null;
  let count = 1;
  let current = first.parentId ? byId.get(first.parentId) : undefined;
  while (current) {
    if (b === null) {
      if (current.authorId === a) break;
      b = current.authorId;
    } else {
      const expected = count % 2 === 0 ? a : b;
      if (current.authorId !== expected) break;
    }
    count += 1;
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return count;
}

export interface HourBin {
  start: Date;
  belgradeHour: number;
  count: number;
  /** False for hours that the outage, the pause or a degraded budget stage distort. */
  eligible: boolean;
}

export function averageCount(bins: readonly HourBin[]): number | null {
  const eligible = bins.filter((b) => b.eligible);
  if (eligible.length === 0) return null;
  return eligible.reduce((sum, b) => sum + b.count, 0) / eligible.length;
}

/** The most the scheduler may plan in the hour after a restart, summed over paced kinds. */
export function burstBound(scenario: Scenario, hour: number): number {
  const { content, scheduler } = scenario.config;
  let total = 1; // one summary
  for (const kind of ["thread", "reply", "revision", "vote"] as const) {
    total += burstLimit(hourlyExpected(dailyMaxFor(kind, content), hour, scheduler), 0);
  }
  return total;
}

interface Window {
  from: Date;
  to: Date;
}

function overlaps(start: Date, end: Date, window: Window | null): boolean {
  return window !== null && start < window.to && end > window.from;
}

export function windowOf(
  scenario: Scenario,
  w: { fromHour: number; toHour: number } | null,
): Window | null {
  if (!w) return null;
  return {
    from: new Date(scenario.start.getTime() + w.fromHour * HOUR),
    to: new Date(scenario.start.getTime() + w.toHour * HOUR),
  };
}

export function hourBins(input: EvalInput): HourBin[] {
  const { scenario, decisions, runs } = input;
  const outage = input.outageWindow;
  const pause = input.pauseWindow ?? windowOf(scenario, scenario.forumPause);
  const bins: HourBin[] = [];
  for (let i = 0; i < scenario.hours; i += 1) {
    const start = new Date(scenario.start.getTime() + i * HOUR);
    const end = new Date(start.getTime() + HOUR);
    const count = decisions.filter((d) => d.createdAt >= start && d.createdAt < end).length;
    const ranHere = runs.filter((r) => r.tickAt >= start && r.tickAt < end);
    const afterOutage =
      outage !== null && start >= outage.to && start.getTime() < outage.to.getTime() + HOUR;
    const normalOnly = ranHere.length > 0 && ranHere.every((r) => r.stage === "normal");
    bins.push({
      start,
      belgradeHour: belgradeHour(start),
      count,
      eligible:
        normalOnly &&
        !afterOutage &&
        !overlaps(start, end, outage) &&
        !overlaps(start, end, pause) &&
        end <= input.end,
    });
  }
  return bins;
}

const fmt = (n: number): string => (Math.round(n * 100) / 100).toString();
const usd = (micros: number): string => `USD ${(micros / 1e6).toFixed(4)}`;

function result(
  id: number,
  name: string,
  problems: string[],
  detail: string,
  status: CheckStatus = problems.length === 0 ? "pass" : "fail",
): CheckResult {
  return { id, name, status, detail, problems };
}

const notEvaluated = (id: number, name: string, why: string): CheckResult =>
  result(id, name, [], why, "not_evaluated");

export function evaluateChecks(input: EvalInput): CheckResult[] {
  const { scenario, decisions, content, personas } = input;
  const { config } = scenario;
  const executed = decisions.filter(isExecuted);
  const personaById = new Map(personas.map((p) => [p.id, p]));
  const results: CheckResult[] = [];

  // 1. Daily maxima per kind, counted on the Belgrade day the decision was planned.
  {
    const problems: string[] = [];
    const counts = groupCount(executed, (d) => `${belgradeDayKey(d.createdAt)}|${d.kind}`);
    let worst = 0;
    for (const [key, n] of counts) {
      const [day, kind] = key.split("|") as [string, ActionKind];
      const max =
        kind === "summary"
          ? config.content.maxSummariesPerDay
          : dailyMaxFor(kind, config.content);
      worst = Math.max(worst, n / max);
      if (n > max)
        problems.push(`${day} ${kind}: ${n} published or quarantined, maximum ${max}`);
    }
    results.push(
      result(
        1,
        "Daily maximum per kind",
        problems,
        `highest use ${fmt(worst * 100)} % of a maximum`,
      ),
    );
  }

  // 2. Per persona and day.
  {
    const problems: string[] = [];
    const mine = executed.filter((d) => ["thread", "reply", "revision"].includes(d.kind));
    const counts = groupCount(mine, (d) => `${d.personaId}|${belgradeDayKey(d.createdAt)}`);
    let worst = 0;
    for (const [key, n] of counts) {
      const [id = "", day = ""] = key.split("|");
      const p = personaById.get(id);
      if (!p) continue;
      const cap = Math.min(
        p.maxContentActionsPerDay,
        config.personas.maxContentActionsPerPersonaPerDay,
      );
      worst = Math.max(worst, n / cap);
      if (n > cap) problems.push(`${p.name} on ${day}: ${n} content actions, limit ${cap}`);
    }
    results.push(
      result(
        2,
        "Persona daily limit",
        problems,
        `highest use ${fmt(worst * 100)} % of a limit`,
      ),
    );
  }

  // 3. Cooldown between a persona's consecutive threads and comments.
  {
    const problems: string[] = [];
    const byAuthor = new Map<string, ContentFact[]>();
    for (const c of content) {
      const list = byAuthor.get(c.authorId) ?? [];
      list.push(c);
      byAuthor.set(c.authorId, list);
    }
    let minRatio = Infinity;
    for (const [id, list] of byAuthor) {
      const p = personaById.get(id);
      if (!p) continue;
      const cooldown = Math.max(
        p.replyCooldownMinutes,
        config.personas.minimumReplyCooldownMinutes,
      );
      list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      for (let i = 1; i < list.length; i += 1) {
        const later = list[i] as ContentFact;
        const earlier = list[i - 1] as ContentFact;
        if (later.createdAt < scenario.start) continue;
        const gap = (later.createdAt.getTime() - earlier.createdAt.getTime()) / MINUTE;
        minRatio = Math.min(minRatio, gap / cooldown);
        if (gap < cooldown) {
          problems.push(
            `${p.name}: ${fmt(gap)} min between two posts, cooldown ${cooldown} min`,
          );
        }
      }
    }
    results.push(
      result(
        3,
        "Persona cooldown",
        problems,
        minRatio === Infinity
          ? "no consecutive posts"
          : `smallest gap is ${fmt(minRatio * 100)} % of its cooldown`,
      ),
    );
  }

  // 4. Alternating pair chains.
  {
    const problems: string[] = [];
    const byId = new Map(content.filter((c) => !c.isThread).map((c) => [c.id, c]));
    const max = config.personas.maxConsecutivePairReplies;
    let longest = 0;
    for (const c of byId.values()) {
      const length = alternatingChainLength(c.id, byId);
      longest = Math.max(longest, length);
      if (length > max)
        problems.push(`comment ${c.id}: alternating chain of ${length}, limit ${max}`);
    }
    results.push(
      result(4, "Pair reply chains", problems, `longest chain ${longest}, limit ${max}`),
    );
  }

  // 5. Contributions per persona, thread and day.
  {
    const problems: string[] = [];
    // Only public comments count as contributions; a quarantined draft is not one.
    const replies = decisions.filter(
      (d) => d.kind === "reply" && d.outcome === "published" && d.threadId,
    );
    const counts = groupCount(
      replies,
      (d) => `${d.personaId}|${d.threadId}|${belgradeDayKey(d.createdAt)}`,
    );
    const cap = config.scheduler.maxThreadContributionsPerPersonaPerDay;
    let most = 0;
    for (const [key, n] of counts) {
      most = Math.max(most, n);
      if (n > cap) problems.push(`${key}: ${n} replies in one thread and day, limit ${cap}`);
    }
    results.push(result(5, "Thread contributions", problems, `most ${most}, limit ${cap}`));
  }

  // 6. Night rate against day rate, over hours with no distortion.
  const bins = hourBins(input);
  const { nightStartHour: ns, nightEndHour: ne } = config.scheduler;
  const nightBins = bins.filter((b) => isNightHour(b.belgradeHour, ns, ne));
  const dayBins = bins.filter((b) => !isNightHour(b.belgradeHour, ns, ne));
  const nightAvg = averageCount(nightBins);
  const dayAvg = averageCount(dayBins);
  if (nightAvg === null || dayAvg === null || dayAvg === 0) {
    results.push(
      notEvaluated(
        6,
        "Night rate",
        "no undistorted night hour and day hour to compare in this run",
      ),
    );
  } else {
    const nightHours = nightBins.filter((b) => b.eligible).length;
    const dayHours = dayBins.filter((b) => b.eligible).length;
    const problems =
      nightAvg <= 0.25 * dayAvg
        ? []
        : [`night ${fmt(nightAvg)} per hour is above 25 % of day ${fmt(dayAvg)} per hour`];
    results.push(
      result(
        6,
        "Night rate",
        problems,
        `${fmt(nightAvg)} per hour over ${nightHours} night hours, ${fmt(dayAvg)} per hour over ${dayHours} day hours (${fmt((nightAvg / dayAvg) * 100)} %)`,
      ),
    );
  }

  // 7. No catch-up after the outage.
  {
    const outage = input.outageWindow;
    if (!outage || outage.to.getTime() + HOUR > input.end.getTime()) {
      results.push(
        notEvaluated(7, "No catch-up", "no outage that ended an hour before the run did"),
      );
    } else {
      const firstHour = decisions.filter(
        (d) => d.createdAt >= outage.to && d.createdAt < new Date(outage.to.getTime() + HOUR),
      ).length;
      const burst = burstBound(scenario, belgradeHour(outage.to));
      const bound = Math.max(burst, 1.5 * (dayAvg ?? 0));
      const problems =
        firstHour <= bound
          ? []
          : [`${firstHour} actions planned in the hour after the outage, bound ${fmt(bound)}`];
      results.push(
        result(
          7,
          "No catch-up",
          problems,
          `${firstHour} planned in the first hour back, bound ${fmt(bound)} (burst ${burst}, 1.5 x day average ${fmt(1.5 * (dayAvg ?? 0))})`,
        ),
      );
    }
  }

  // 8. The pause.
  {
    const pause = input.pauseWindow;
    if (!pause || pause.to > input.end) {
      results.push(notEvaluated(8, "Pause holds", "no pause window inside this run"));
    } else {
      const problems: string[] = [];
      if (input.rowsCreatedInPause > 0) {
        problems.push(`${input.rowsCreatedInPause} rows were created during the pause`);
      }
      const inside = decisions.filter(
        (d) => d.completedAt && d.completedAt >= pause.from && d.completedAt < pause.to,
      );
      for (const d of inside) {
        if (d.outcome !== "skipped" || d.code !== "paused") {
          problems.push(
            `decision ${d.id} (${d.kind}) ended ${d.outcome}/${d.code} inside the pause`,
          );
        }
      }
      results.push(
        result(
          8,
          "Pause holds",
          problems,
          `${inside.length} jobs came due inside the pause; nothing was created`,
        ),
      );
    }
  }

  // 9. Spend never above a limit.
  {
    const problems: string[] = [];
    let worst = 0;
    const lower = scenario.lowerDailyLimit;
    const lowerStart = lower
      ? new Date(scenario.start.getTime() + lower.fromHour * HOUR)
      : null;
    for (const p of input.periods) {
      const used = p.spentMicros + p.reservedMicros;
      worst = Math.max(worst, p.limitMicros === 0 ? 0 : used / p.limitMicros);
      const label = `${p.kind} ${p.start.toISOString().slice(0, 10)}`;
      if (used > p.limitMicros) {
        problems.push(
          `${label}: spent + reserved ${usd(used)} above limit ${usd(p.limitMicros)}`,
        );
      }
      if (p.kind === "day") {
        const lowered =
          lower !== null && lowerStart !== null && p.start >= utcDayStart(lowerStart);
        const expected = Math.round(
          (lowered && lower ? lower.limitUsd : config.budget.dailyVariableSpendLimit) * 1e6,
        );
        if (p.limitMicros > expected) {
          problems.push(
            `${label}: recorded limit ${usd(p.limitMicros)} is above the highest the scenario sets, ${usd(expected)}`,
          );
        }
      }
    }
    results.push(
      result(
        9,
        "Spend within limits",
        problems,
        `highest use ${fmt(worst * 100)} % of a limit`,
      ),
    );
  }

  // 10. Stage order on the lowered-limit day.
  {
    const lower = scenario.lowerDailyLimit;
    if (!lower) {
      results.push(
        notEvaluated(10, "Budget stages", "no lowered daily limit in this scenario"),
      );
    } else {
      const from = new Date(scenario.start.getTime() + lower.fromHour * HOUR);
      const to = utcNextDayStart(from);
      const day = input.runs
        .filter((r) => r.tickAt >= from && r.tickAt < to)
        .sort((a, b) => a.tickAt.getTime() - b.tickAt.getTime());
      const problems: string[] = [];
      let top = 0;
      const seen = new Set<BudgetStage>();
      for (const r of day) {
        seen.add(r.stage);
        if (STAGE_RANK[r.stage] < top) {
          problems.push(`stage moved back to ${r.stage} at ${r.tickAt.toISOString()}`);
          break;
        }
        top = Math.max(top, STAGE_RANK[r.stage]);
      }
      if (to <= input.end) {
        for (const stage of ["reduced", "minimal", "paused"] as const) {
          if (!seen.has(stage)) problems.push(`stage ${stage} never appeared`);
        }
      }
      results.push(
        result(
          10,
          "Budget stages",
          problems,
          `stages seen on the lowered day: ${[...seen].join(", ") || "none"}`,
        ),
      );
    }
  }

  // 11. Diversity.
  {
    const newThreads = content.filter((c) => c.isThread && c.createdAt >= scenario.start);
    const newComments = content.filter((c) => !c.isThread && c.createdAt >= scenario.start);
    if (newThreads.length < 8 || newComments.length < 30) {
      results.push(
        notEvaluated(
          11,
          "Diversity",
          `too little content to judge (${newThreads.length} threads, ${newComments.length} comments)`,
        ),
      );
    } else {
      const problems: string[] = [];
      const byCommunity = groupCount(newThreads, (c) => c.communityId ?? "none");
      const byAuthor = groupCount(newComments, (c) => c.authorId);
      const minCommunities = Math.ceil(0.6 * input.communityCount);
      const minPersonas = Math.ceil(0.75 * personas.length);
      if (byCommunity.size < minCommunities) {
        problems.push(
          `only ${byCommunity.size} of ${input.communityCount} communities got new threads, need ${minCommunities}`,
        );
      }
      if (topShare(byCommunity) > 0.35) {
        problems.push(
          `top community has ${fmt(topShare(byCommunity) * 100)} % of new threads, limit 35 %`,
        );
      }
      if (topShare(byAuthor) > 0.15) {
        problems.push(
          `top persona wrote ${fmt(topShare(byAuthor) * 100)} % of comments, limit 15 %`,
        );
      }
      if (byAuthor.size < minPersonas) {
        problems.push(
          `only ${byAuthor.size} of ${personas.length} personas commented, need ${minPersonas}`,
        );
      }
      results.push(
        result(
          11,
          "Diversity",
          problems,
          `${byCommunity.size}/${input.communityCount} communities, top community ${fmt(topShare(byCommunity) * 100)} %, top persona ${fmt(topShare(byAuthor) * 100)} %, ${byAuthor.size}/${personas.length} personas commented`,
        ),
      );
    }
  }

  // 12. Queue bounds and terminal outcomes.
  {
    const problems: string[] = [];
    const max = config.runtime.maxPendingJobs;
    if (input.queue.maxPending > max) {
      problems.push(`pending jobs peaked at ${input.queue.maxPending}, limit ${max}`);
    }
    const stuck = decisions.filter((d) => d.outcome === "queued").length;
    if (stuck > 0) problems.push(`${stuck} decisions are still queued after the final drain`);
    if (input.queue.deadLetters < input.scriptedFailures) {
      problems.push(
        `${input.queue.deadLetters} dead letters for ${input.scriptedFailures} scripted failures`,
      );
    }
    const deadDecisions = decisions.filter((d) => d.code === "dead_letter").length;
    if (deadDecisions !== input.queue.deadLetters) {
      problems.push(
        `${input.queue.deadLetters} dead-lettered jobs but ${deadDecisions} decisions say dead_letter`,
      );
    }
    results.push(
      result(
        12,
        "Queue bounds",
        problems,
        `peak pending ${input.queue.maxPending} of ${max}, ${input.queue.deadLetters} dead letters, ${input.queue.retries} retries`,
      ),
    );
  }

  // 13. No duplicate publication.
  {
    const problems: string[] = [];
    if (input.duplicateActionKeys > 0) {
      problems.push(`${input.duplicateActionKeys} action keys appear twice`);
    }
    const publishedThreads = decisions.filter(
      (d) => d.kind === "thread" && d.outcome === "published",
    ).length;
    const publishedReplies = decisions.filter(
      (d) => d.kind === "reply" && d.outcome === "published",
    ).length;
    if (publishedThreads !== input.publishedThreadsNew) {
      problems.push(
        `${publishedThreads} published thread decisions but ${input.publishedThreadsNew} new threads`,
      );
    }
    if (publishedReplies !== input.publishedCommentsNew) {
      problems.push(
        `${publishedReplies} published reply decisions but ${input.publishedCommentsNew} new comments`,
      );
    }
    let detail = "published decisions and new content match one to one";
    const dup = input.duplicate;
    if (scenario.duplicateDeliveryHour !== null) {
      if (!dup) {
        problems.push("the duplicate delivery never happened");
      } else {
        detail += `; the duplicate delivery of job ${dup.jobId.slice(0, 8)} ended ${dup.outcome}/${dup.code}`;
        if (dup.outcome !== "skipped") {
          problems.push(`duplicate delivery ended ${dup.outcome}, expected skipped`);
        }
        if (dup.contentAfter !== dup.contentBefore) {
          problems.push(
            `duplicate delivery changed the content count from ${dup.contentBefore} to ${dup.contentAfter}`,
          );
        }
        if (dup.decisionOutcomeAfter !== dup.decisionOutcomeBefore) {
          problems.push(
            `duplicate delivery changed the decision from ${dup.decisionOutcomeBefore} to ${dup.decisionOutcomeAfter}`,
          );
        }
      }
    }
    results.push(result(13, "No duplicates", problems, detail));
  }

  // 14. Retention.
  {
    const r = input.retention;
    const ran = (name: string): boolean => (input.cleanup.runs[name] ?? 0) > 0;
    const problems: string[] = [];
    const parts: string[] = [];
    const fx = scenario.retention;
    if (ran("cleanup-sessions")) {
      parts.push("sessions");
      if (r.expiredSessionsLeft > 0) {
        problems.push(`${r.expiredSessionsLeft} expired sessions remain`);
      }
      if (r.validSessionsLeft !== fx.validSessions) {
        problems.push(`${r.validSessionsLeft} of ${fx.validSessions} valid sessions remain`);
      }
    }
    if (ran("cleanup-login-attempts")) {
      parts.push("login attempts");
      if (r.oldLoginAttemptsLeft > 0) {
        problems.push(`${r.oldLoginAttemptsLeft} old login attempts remain`);
      }
    }
    if (ran("cleanup-persona-memory")) {
      parts.push("memories");
      if (r.expiredMemoriesLeft > 0) {
        problems.push(`${r.expiredMemoriesLeft} expired memories remain`);
      }
      for (const n of input.cleanup.maxMemoriesAfterCleanup) {
        if (n > 60)
          problems.push(`a persona held ${n} memories right after a cleanup, limit 60`);
      }
    }
    results.push(
      parts.length === 0
        ? notEvaluated(14, "Retention", "no cleanup time was reached in this run")
        : result(
            14,
            "Retention",
            problems,
            `checked ${parts.join(", ")}; largest memory count right after cleanup ${Math.max(0, ...input.cleanup.maxMemoriesAfterCleanup)}`,
          ),
    );
  }

  // 15. At most one paid repair per action key, across retries.
  {
    const problems: string[] = [];
    if (input.repairKeysOverLimit > 0) {
      problems.push(`${input.repairKeysOverLimit} action keys were repaired more than once`);
    }
    const expected = (scenario.faults.badDraftRate ?? 0) > 0;
    if (expected && input.repairCalls === 0) {
      problems.push("bad drafts were injected but no repair was ever requested");
    }
    results.push(
      result(
        15,
        "One repair per action",
        problems,
        `${input.repairCalls} repair calls over ${input.repairKeys} actions, none repeated`,
      ),
    );
  }

  // 16. A quarantined decision never publishes anything.
  {
    const problems: string[] = [];
    if (input.quarantinedWithContent > 0) {
      problems.push(
        `${input.quarantinedWithContent} quarantined decisions have published content`,
      );
    }
    const expected = (scenario.faults.badDraftRate ?? 0) > 0;
    if (expected && input.quarantinedDecisions === 0) {
      problems.push("bad repairs were injected but nothing was quarantined");
    }
    results.push(
      result(
        16,
        "Quarantine publishes nothing",
        problems,
        `${input.quarantinedDecisions} quarantined decisions, none with published content`,
      ),
    );
  }

  return results;
}

export function violationsOf(checks: readonly CheckResult[]): string[] {
  const out: string[] = [];
  for (const c of checks) {
    if (c.status !== "fail") continue;
    for (const p of c.problems.slice(0, 6)) out.push(`#${c.id} ${c.name}: ${p}`);
    if (c.problems.length > 6)
      out.push(`#${c.id} ${c.name}: and ${c.problems.length - 6} more`);
  }
  return out;
}
