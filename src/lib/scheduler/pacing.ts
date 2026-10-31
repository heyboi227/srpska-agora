import type { AgoraConfig, SchedulerConfig } from "@/lib/config/schema";
import type { ActionKind } from "@/lib/jobs/types";
import { SeededRandom } from "@/lib/random";
import { isNightHour } from "@/lib/time";
import { SLOT_DROP_ORDER } from "./weights";

/**
 * Pacing is pure arithmetic on the clock and on what has already been planned.
 * It deliberately never looks at how long the worker was down: after an outage
 * the next tick expects the normal amount for its own hour, so a restart
 * resumes at the usual rate instead of catching up on missed time.
 */

export type SlotCounts = Record<ActionKind, number>;

export const PACED_KINDS = ["thread", "reply", "revision", "vote"] as const;
export type PacedKind = (typeof PACED_KINDS)[number];

export function emptyCounts(): SlotCounts {
  return { thread: 0, reply: 0, revision: 0, summary: 0, vote: 0 };
}

/** pg-boss schedules by the minute, so a configured period below 60 seconds behaves as 60. */
export function periodSeconds(config: AgoraConfig): number {
  return Math.max(60, config.runtime.schedulerTickSeconds);
}

export function dailyMaxFor(kind: PacedKind, content: AgoraConfig["content"]): number {
  switch (kind) {
    case "thread":
      return content.maxNewThreadsPerDay;
    case "reply":
      return content.maxNewCommentsPerDay;
    case "revision":
      return content.maxRevisionsPerDay;
    case "vote":
      return content.maxVotesPerDay;
  }
}

/** Night hours run at `nightActivityPercent`, all others at full weight. */
export function hourWeight(hour: number, s: SchedulerConfig): number {
  return isNightHour(hour, s.nightStartHour, s.nightEndHour) ? s.nightActivityPercent / 100 : 1;
}

export function dayWeightSum(s: SchedulerConfig): number {
  let sum = 0;
  for (let h = 0; h < 24; h += 1) sum += hourWeight(h, s);
  return sum;
}

/** Expected actions in one clock hour: the daily maximum spread by the hourly curve. */
export function hourlyExpected(dailyMax: number, hour: number, s: SchedulerConfig): number {
  const sum = dayWeightSum(s);
  if (sum <= 0) return 0;
  return (dailyMax * hourWeight(hour, s)) / sum;
}

/** Expected actions in one tick of `periodSec` seconds. */
export function expectedSlots(
  dailyMax: number,
  hour: number,
  s: SchedulerConfig,
  periodSec: number,
): number {
  return (hourlyExpected(dailyMax, hour, s) * periodSec) / 3600;
}

/** Rounds a fractional expectation with one seeded draw: floor, plus one with probability frac. */
export function drawSlots(expected: number, rng: SeededRandom): number {
  const whole = Math.floor(expected);
  return whole + (rng.next() < expected - whole ? 1 : 0);
}

/** The most that may be planned in one hour, given what the last hour already holds. */
export function burstLimit(hourly: number, plannedLastHour: number): number {
  return Math.max(0, Math.ceil(2 * hourly + 1) - plannedLastHour);
}

export interface SlotPlan {
  expected: number;
  /** After the draw and the per-kind caps, before the per-tick cap. */
  capped: number;
  /** Final. */
  drawn: number;
}

export interface SlotPlanInput {
  hour: number;
  scheduler: SchedulerConfig;
  content: AgoraConfig["content"];
  periodSec: number;
  usedToday: SlotCounts;
  plannedLastHour: SlotCounts;
  /** Threads that need a summary right now. */
  dueSummaries: number;
  maxActionsPerTick: number;
  seed: string;
}

/** Slots per kind for one tick. The draws are always taken in the same order, so a seed repeats. */
export function planSlots(input: SlotPlanInput): Record<ActionKind, SlotPlan> {
  const rng = new SeededRandom(input.seed);
  const plans = {} as Record<ActionKind, SlotPlan>;
  for (const kind of PACED_KINDS) {
    const dailyMax = dailyMaxFor(kind, input.content);
    const expected = expectedSlots(dailyMax, input.hour, input.scheduler, input.periodSec);
    const raw = drawSlots(expected, rng);
    const remainingToday = Math.max(0, dailyMax - input.usedToday[kind]);
    const burst = burstLimit(
      hourlyExpected(dailyMax, input.hour, input.scheduler),
      input.plannedLastHour[kind],
    );
    const capped = Math.min(raw, remainingToday, burst);
    plans[kind] = { expected, capped, drawn: capped };
  }
  // Summaries are driven by backlog, not by the clock: at most one per tick.
  const remainingSummaries = Math.max(
    0,
    input.content.maxSummariesPerDay - input.usedToday.summary,
  );
  const summaryCapped = Math.min(input.dueSummaries > 0 ? 1 : 0, remainingSummaries);
  plans.summary = {
    expected: Math.min(1, input.dueSummaries),
    capped: summaryCapped,
    drawn: summaryCapped,
  };

  const trimmed = applyTickCap(
    {
      thread: plans.thread.capped,
      reply: plans.reply.capped,
      revision: plans.revision.capped,
      summary: plans.summary.capped,
      vote: plans.vote.capped,
    },
    input.maxActionsPerTick,
  );
  for (const kind of Object.keys(plans) as ActionKind[]) plans[kind].drawn = trimmed[kind];
  return plans;
}

/** Keeps the total at or under `max`, dropping votes first, then revisions, threads, replies, summaries. */
export function applyTickCap(slots: SlotCounts, max: number): SlotCounts {
  const result = { ...slots };
  let excess = Object.values(result).reduce((a, b) => a + b, 0) - max;
  for (const kind of SLOT_DROP_ORDER) {
    if (excess <= 0) break;
    const cut = Math.min(excess, result[kind]);
    result[kind] -= cut;
    excess -= cut;
  }
  return result;
}
