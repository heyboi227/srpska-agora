import { STANDARD_PRESET } from "@/lib/config/presets";
import type { AgoraConfig } from "@/lib/config/schema";
import { SIMULATION_PRICE_TABLE, type PriceTable } from "@/lib/costs";
import { DEFAULT_BAD_DRAFT_RATE, type FaultRates } from "./faults";

/** A half-open window measured in simulated hours from the start. */
export interface HourWindow {
  fromHour: number;
  toHour: number;
}

export interface RetentionFixtures {
  expiredSessions: number;
  validSessions: number;
  oldLoginAttempts: number;
  /** One persona gets this many memories, of which `expiredMemories` are already expired. */
  memories: number;
  expiredMemories: number;
}

export interface Scenario {
  name: string;
  start: Date;
  hours: number;
  tickMinutes: number;
  seed: string;
  config: AgoraConfig;
  prices: PriceTable;
  faults: FaultRates;
  /** No ticks, no jobs and no cleanup while the worker is down. */
  workerOutage: HourWindow | null;
  /** pauseAllActions is on inside the window. */
  forumPause: HourWindow | null;
  /** From this hour the daily spend limit drops to the given value. */
  lowerDailyLimit: { fromHour: number; limitUsd: number } | null;
  /**
   * At this hour the owner lowers the daily limit to the amount spent so far,
   * which shows the paused stage. Spending in the minimal stage slows to a
   * trickle on its own and drifts towards the last 5 % without reliably
   * crossing it, so the paused stage is demonstrated this way.
   */
  cutDailyLimitHour: number | null;
  /** A completed job is delivered a second time at this hour. */
  duplicateDeliveryHour: number | null;
  /** The first model-driven decision planned at or after this hour fails on every attempt. */
  scriptedFailureHour: number | null;
  retention: RetentionFixtures;
}

export const DEFAULT_START = new Date("2026-11-02T04:00:00Z");

export interface ScenarioOptions {
  tickMinutes?: number;
  hours?: number;
  seed?: string;
}

/**
 * Monday 05:00 in Belgrade, 48 hours, standard preset. The worker is down from
 * hour 3 to 9 (08:00 to 14:00, daytime), the forum paused from hour 30 to 32, and the
 * daily limit falls to USD 0.06 at hour 20, the start of the second UTC budget
 * day, so reduced and minimal appear; at hour 42 the owner lowers the day's limit to
 * what is spent so far, which shows the paused stage. Four in a hundred first drafts
 * come back in English, so the repair and the quarantine paths run.
 */
export function defaultScenario(options: ScenarioOptions = {}): Scenario {
  const tickMinutes = options.tickMinutes ?? 1;
  const config = structuredClone(STANDARD_PRESET);
  config.runtime.schedulerTickSeconds = tickMinutes * 60;
  return {
    name: "default-48h",
    start: DEFAULT_START,
    hours: options.hours ?? 48,
    tickMinutes,
    seed: options.seed ?? "agora-sim-1",
    config,
    prices: SIMULATION_PRICE_TABLE,
    faults: {
      transientRate: 0.03,
      ambiguousRate: 0.01,
      badDraftRate: DEFAULT_BAD_DRAFT_RATE,
    },
    // Monday 08:00 to 14:00 in Belgrade, while the personas are awake, so "no catch-up" is a real test.
    workerOutage: { fromHour: 3, toHour: 9 },
    forumPause: { fromHour: 30, toHour: 32 },
    lowerDailyLimit: { fromHour: 20, limitUsd: 0.06 },
    cutDailyLimitHour: 42,
    duplicateDeliveryHour: 10,
    scriptedFailureHour: 26,
    retention: {
      expiredSessions: 5,
      validSessions: 2,
      oldLoginAttempts: 20,
      memories: 70,
      expiredMemories: 10,
    },
  };
}

/** A plain run without events, for determinism checks and quick looks. */
export function quietScenario(options: ScenarioOptions = {}): Scenario {
  return {
    ...defaultScenario(options),
    name: "quiet",
    workerOutage: null,
    forumPause: null,
    lowerDailyLimit: null,
    cutDailyLimitHour: null,
    duplicateDeliveryHour: null,
    scriptedFailureHour: null,
  };
}
