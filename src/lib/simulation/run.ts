import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { ManualClock } from "@/lib/clock";
import {
  getActiveConfigRevision,
  invalidateConfigCache,
  saveConfigRevision,
} from "@/lib/config/service";
import type { AgoraConfig } from "@/lib/config/schema";
import { CostGateway, getBudgetStatus, meterProviders } from "@/lib/costs";
import type { Db } from "@/lib/db/client";
import { loginAttempts, personaMemories, personas, sessions, accounts } from "@/lib/db/schema";
import { buildServiceContext } from "@/lib/domain/context";
import { CLEANUP_SCHEDULE, runCleanup, type CleanupKind } from "@/lib/jobs/cleanup";
import { recordDeadLetter } from "@/lib/jobs/dead-letter";
import { executeActionJob, type JobDeps, type JobOutcome } from "@/lib/jobs/handlers";
import { MemoryJobQueue, type MemoryJob } from "@/lib/jobs/memory-queue";
import { createProviders } from "@/lib/providers";
import { SeededRandom } from "@/lib/random";
import { runSchedulerTick } from "@/lib/scheduler";
import { seedDemo } from "@/lib/seed/demo";
import { cronMatches, minutesBetween } from "./cron";
import type { CleanupSummary, DuplicateDelivery } from "./checks";
import { FaultInjector, type FaultTally } from "./faults";
import type { Scenario } from "./scenario";
import { truncateAll } from "./tables";

const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAY = 24 * HOUR;
/** Jobs that are still waiting when the last tick ends get this long to finish. */
/** The pause waits for a tick with queued work, but at most this long. */
const PAUSE_WAIT_HOURS = 0.25;
/** Same for the outage: it begins at a tick that left jobs in the queue. */
const OUTAGE_WAIT_HOURS = 0.5;
const FINAL_DRAIN_MS = 2 * HOUR;
const MODEL_KINDS = new Set(["thread", "reply", "revision", "summary"]);

export interface Progress {
  tick: number;
  totalTicks: number;
  at: Date;
}

export interface SimulationOptions {
  onProgress?(progress: Progress): void;
}

export interface RetentionIds {
  expiredSessionIds: string[];
  validSessionIds: string[];
  oldLoginKeys: string[];
  expiredMemoryIds: string[];
  fixturePersonaId: string | null;
}

/** What the loop observed; the report adds what the database knows. */
export interface RunRecord {
  end: Date;
  wallMs: number;
  ticksRun: number;
  ticksSkippedForOutage: number;
  queue: {
    sent: number;
    completed: number;
    retries: number;
    deadLetters: number;
    maxPending: number;
  };
  faults: FaultTally;
  scriptedFailureKeys: string[];
  duplicate: DuplicateDelivery | null;
  cleanup: CleanupSummary;
  retention: RetentionIds;
  events: { at: Date; text: string }[];
  /** When the pause really took effect and ended. */
  pauseWindow: { from: Date; to: Date | null } | null;
  /** When the worker really went down and when it came back. */
  outageWindow: { from: Date; to: Date } | null;
}

const quiet = (): void => {};

async function loadActive(db: Db): Promise<AgoraConfig> {
  const active = await getActiveConfigRevision(db);
  if (!active) throw new Error("No active configuration revision.");
  return active.config;
}

async function applyConfig(
  db: Db,
  mutate: (config: AgoraConfig) => void,
  reason: string,
): Promise<AgoraConfig> {
  const next = structuredClone(await loadActive(db));
  mutate(next);
  await saveConfigRevision(db, {
    config: next,
    changeKind: "system",
    changedByAccountId: null,
    reason,
  });
  invalidateConfigCache();
  return loadActive(db);
}

async function insertRetentionFixtures(db: Db, scenario: Scenario): Promise<RetentionIds> {
  const { start, retention } = scenario;
  const ids: RetentionIds = {
    expiredSessionIds: [],
    validSessionIds: [],
    oldLoginKeys: [],
    expiredMemoryIds: [],
    fixturePersonaId: null,
  };

  const [account] = await db
    .insert(accounts)
    .values({ username: "sim-retention", role: "system", isActive: false })
    .returning({ id: accounts.id });
  if (!account) throw new Error("Could not create the fixture account.");
  for (let i = 0; i < retention.expiredSessions + retention.validSessions; i += 1) {
    const expired = i < retention.expiredSessions;
    const [row] = await db
      .insert(sessions)
      .values({
        accountId: account.id,
        tokenHash: `sim-fixture-${i}`.padEnd(64, "0"),
        expiresAt: new Date(start.getTime() + (expired ? -2 * DAY : 10 * DAY)),
        lastSeenAt: new Date(start.getTime() - 3 * DAY),
      })
      .returning({ id: sessions.id });
    if (!row) throw new Error("Could not create a fixture session.");
    (expired ? ids.expiredSessionIds : ids.validSessionIds).push(row.id);
  }

  const twoDaysAgo = new Date(start.getTime() - 2 * DAY);
  for (let i = 0; i < retention.oldLoginAttempts; i += 1) {
    const key = `ip:sim-fixture-${i}`;
    await db.insert(loginAttempts).values({
      key,
      failures: 2,
      windowStartedAt: twoDaysAgo,
      lockedUntil: null,
      updatedAt: twoDaysAgo,
    });
    ids.oldLoginKeys.push(key);
  }

  const [persona] = await db
    .select({ id: personas.id })
    .from(personas)
    .orderBy(personas.slug)
    .limit(1);
  if (persona && retention.memories > 0) {
    ids.fixturePersonaId = persona.id;
    for (let i = 0; i < retention.memories; i += 1) {
      const expired = i < retention.expiredMemories;
      const [row] = await db
        .insert(personaMemories)
        .values({
          personaId: persona.id,
          kind: "note",
          content: `Simulacija: beleška ${i + 1}.`,
          createdAt: new Date(start.getTime() - (retention.memories - i) * 60 * MINUTE),
          expiresAt: new Date(start.getTime() + (expired ? -1 * DAY : 20 * DAY)),
        })
        .returning({ id: personaMemories.id });
      if (expired && row) ids.expiredMemoryIds.push(row.id);
    }
  }
  return ids;
}

async function maxMemoriesPerPersona(db: Db): Promise<number> {
  const rows = await db.execute<{ n: number }>(
    sql`select coalesce(max(n), 0)::int as n from (select count(*) as n from persona_memories group by persona_id) x`,
  );
  return Number(rows.rows[0]?.n ?? 0);
}

async function countContent(db: Db): Promise<number> {
  const rows = await db.execute<{ n: number }>(
    sql`select ((select count(*) from threads) + (select count(*) from comments) + (select count(*) from votes) + (select count(*) from thread_summaries))::int as n`,
  );
  return Number(rows.rows[0]?.n ?? 0);
}

/**
 * Runs the scenario against `db`: the real scheduler, job handler, cost
 * gateway, domain services and cleanup, driven by a manual clock, deterministic
 * mock providers priced like the live model, and an in-process queue.
 * The database is emptied first, so only ever point it at a test database.
 */
export async function runSimulation(
  db: Db,
  scenario: Scenario,
  options: SimulationOptions = {},
): Promise<RunRecord> {
  const wallStart = Date.now();
  const { start } = scenario;
  const end = new Date(start.getTime() + scenario.hours * HOUR);
  const tickMs = scenario.tickMinutes * MINUTE;
  const totalTicks = Math.round((scenario.hours * HOUR) / tickMs);

  // Prepare the database.
  await migrate(db, { migrationsFolder: "./drizzle" });
  await truncateAll(db);
  invalidateConfigCache();
  await seedDemo(db, { now: start, createAdmin: false, log: quiet });
  await saveConfigRevision(db, {
    config: scenario.config,
    changeKind: "system",
    changedByAccountId: null,
    reason: `Simulacija „${scenario.name}“: početna konfiguracija.`,
  });
  invalidateConfigCache();
  const retention = await insertRetentionFixtures(db, scenario);

  const clock = new ManualClock(start);
  const rng = new SeededRandom(`${scenario.seed}|queue`);
  const queue = new MemoryJobQueue(() => rng.next());
  const faults = new FaultInjector(scenario.seed, scenario.faults);
  const baseProviders = createProviders("mock");
  const events: RunRecord["events"] = [];
  const log = (text: string): void => {
    events.push({ at: clock.now(), text });
  };

  const record: RunRecord = {
    end,
    wallMs: 0,
    ticksRun: 0,
    ticksSkippedForOutage: 0,
    queue: { sent: 0, completed: 0, retries: 0, deadLetters: 0, maxPending: 0 },
    faults: faults.tally,
    scriptedFailureKeys: [],
    duplicate: null,
    cleanup: { runs: {}, totals: {}, maxMemoriesAfterCleanup: [] },
    retention,
    events,
    pauseWindow: null,
    outageWindow: null,
  };

  let current = await loadActive(db);
  let lastOutcome: JobOutcome | null = null;

  const makeDeps = (attempt: number): JobDeps => ({
    db,
    clock,
    loadConfig: () => loadActive(db),
    buildContext: (config) =>
      buildServiceContext({
        db,
        config,
        clock,
        origin: "simulation",
        providers: meterProviders(
          {
            mode: "mock",
            generation: faults.wrap(baseProviders.generation),
            validation: baseProviders.validation,
            search: baseProviders.search,
          },
          new CostGateway({ db, config, clock, prices: scenario.prices }),
          "simulation",
        ),
      }),
    attempt,
    maxAttempts: current.runtime.maxAutomaticJobAttempts,
  });

  const handler = async (job: MemoryJob, attempt: number): Promise<JobOutcome> => {
    lastOutcome = await executeActionJob(job.payload, makeDeps(attempt));
    return lastOutcome;
  };
  const hooks = {
    now: (): Date => clock.now(),
    setClock: (date: Date): void => {
      if (date > clock.now()) clock.set(date);
    },
    onDeadLetter: async (job: MemoryJob, error: unknown): Promise<void> => {
      await recordDeadLetter(
        db,
        clock,
        job.payload,
        error instanceof Error ? error.message : String(error),
      );
      log(`Dead letter: ${job.kind} job for ${job.payload.actionKey}`);
    },
  };

  const outage = scenario.workerOutage;
  const pause = scenario.forumPause;
  const lower = scenario.lowerDailyLimit;
  let limitLowered = false;
  let limitCut = false;
  let outageStarted = false;
  let paused = false;
  let lastCronCheck = new Date(start.getTime() - MINUTE);
  let failuresPlanned = 0;
  let duplicateDone = scenario.duplicateDeliveryHour === null;

  const runCleanupJob = async (kind: CleanupKind): Promise<void> => {
    const counts = await runCleanup(kind, { db, config: current, clock });
    record.cleanup.runs[kind] = (record.cleanup.runs[kind] ?? 0) + 1;
    const totals = (record.cleanup.totals[kind] ??= {});
    for (const [key, value] of Object.entries(counts)) totals[key] = (totals[key] ?? 0) + value;
    if (kind === "cleanup-persona-memory") {
      record.cleanup.maxMemoriesAfterCleanup.push(await maxMemoriesPerPersona(db));
    }
  };

  for (let i = 0; i < totalTicks; i += 1) {
    const at = new Date(start.getTime() + i * tickMs);
    const tickEnd = new Date(at.getTime() + tickMs);
    const hour = (at.getTime() - start.getTime()) / HOUR;
    clock.set(at);
    if (i % Math.max(1, Math.round(60 / scenario.tickMinutes)) === 0) {
      options.onProgress?.({ tick: i, totalTicks, at });
    }

    // Events that change the configuration.
    if (lower && !limitLowered && hour >= lower.fromHour) {
      current = await applyConfig(
        db,
        (c) => {
          c.budget.dailyVariableSpendLimit = lower.limitUsd;
        },
        `Simulacija: dnevni limit spušten na ${lower.limitUsd} USD.`,
      );
      limitLowered = true;
      log(`Daily limit lowered to USD ${lower.limitUsd}`);
    }
    if (
      scenario.cutDailyLimitHour !== null &&
      !limitCut &&
      hour >= scenario.cutDailyLimitHour
    ) {
      const status = await getBudgetStatus(db, current, clock);
      const spentUsd = (status.day.spentMicros + status.day.reservedMicros) / 1e6;
      current = await applyConfig(
        db,
        (c) => {
          c.budget.dailyVariableSpendLimit = spentUsd;
        },
        "Simulacija: dnevni limit postavljen na već potrošeni iznos.",
      );
      limitCut = true;
      log(
        `Owner lowers the daily limit to the USD ${spentUsd.toFixed(4)} already spent (shows the paused stage)`,
      );
    }
    if (pause && paused && hour >= pause.toHour) {
      current = await applyConfig(
        db,
        (c) => {
          c.runtime.pauseAllActions = false;
        },
        "Simulacija: pauza ukinuta.",
      );
      paused = false;
      if (record.pauseWindow) record.pauseWindow.to = at;
      log("Forum resumed");
    }

    // The worker is down: nothing runs, and cron times that pass are not replayed.
    if (outage && outageStarted && hour < outage.toHour) {
      record.ticksSkippedForOutage += 1;
      lastCronCheck = at;
      continue;
    }
    if (outage && hour >= outage.toHour && hour < outage.toHour + scenario.tickMinutes / 60) {
      log("Worker back");
    }

    // One completed job is delivered a second time.
    if (
      !duplicateDone &&
      scenario.duplicateDeliveryHour !== null &&
      hour >= scenario.duplicateDeliveryHour
    ) {
      const done = queue
        .all()
        .filter((j) => j.state === "completed" && (j.kind === "thread" || j.kind === "reply"));
      const candidate = done.find((j) => j.payload.decisionId !== undefined);
      if (candidate) {
        const before = await countContent(db);
        const outcomeBefore = await decisionOutcome(db, candidate.payload.decisionId);
        lastOutcome = null;
        await queue.redeliver(candidate.id, handler);
        const outcome = lastOutcome as JobOutcome | null;
        record.duplicate = {
          jobId: candidate.id,
          outcome: outcome?.outcome ?? "unknown",
          code: outcome?.code ?? null,
          contentBefore: before,
          contentAfter: await countContent(db),
          decisionOutcomeBefore: outcomeBefore,
          decisionOutcomeAfter: await decisionOutcome(db, candidate.payload.decisionId),
        };
        duplicateDone = true;
        log(`Duplicate delivery of job ${candidate.id.slice(0, 8)}`);
      }
    }

    // Cron times crossed since the last tick, in Belgrade time.
    for (const minute of minutesBetween(lastCronCheck, at)) {
      for (const entry of CLEANUP_SCHEDULE) {
        if (cronMatches(entry.cron, minute)) {
          await runCleanupJob(entry.name);
        }
      }
    }
    lastCronCheck = at;

    // Consumers start with the worker: anything already due runs before the next plan.
    await queue.runDue(at, handler, hooks);

    const config = await loadActive(db);
    current = config;
    const result = await runSchedulerTick({ db, config, clock, queue });
    record.ticksRun += 1;

    if (
      scenario.scriptedFailureHour !== null &&
      failuresPlanned === 0 &&
      hour >= scenario.scriptedFailureHour
    ) {
      const target = result.decisions.find((d) => MODEL_KINDS.has(d.kind) && d.jobId !== null);
      if (target) {
        faults.failPermanently(target.actionKey);
        record.scriptedFailureKeys.push(target.actionKey);
        failuresPlanned += 1;
        log(`Scripted permanent failure planned for ${target.kind} ${target.actionKey}`);
      }
    }

    // The worker is killed right after a tick enqueued its jobs (the first such
    // tick at or after the outage hour), so those jobs wait out the outage.
    if (
      outage &&
      !outageStarted &&
      hour >= outage.fromHour &&
      hour < outage.toHour &&
      (result.decisions.length > 0 || hour >= outage.fromHour + OUTAGE_WAIT_HOURS)
    ) {
      outageStarted = true;
      record.outageWindow = { from: at, to: new Date(start.getTime() + outage.toHour * HOUR) };
      log(`Worker outage begins; it dies with ${result.decisions.length} jobs queued`);
      continue;
    }

    // The owner pauses the forum right after this tick planned its work, so
    // whatever is queued must meet the pause instead of running.
    const lateForPause = pause ? hour >= pause.fromHour + PAUSE_WAIT_HOURS : false;
    if (
      pause &&
      !paused &&
      hour >= pause.fromHour &&
      hour < pause.toHour &&
      (result.decisions.length > 0 || lateForPause)
    ) {
      current = await applyConfig(
        db,
        (c) => {
          c.runtime.pauseAllActions = true;
        },
        "Simulacija: forum pauziran.",
      );
      paused = true;
      record.pauseWindow = { from: at, to: null };
      log(`Forum paused with ${result.decisions.length} jobs queued`);
    }

    await queue.runDue(tickEnd, handler, hooks);
  }

  // Let every remaining job reach a verdict.
  clock.set(end);
  await queue.runDue(new Date(end.getTime() + FINAL_DRAIN_MS), handler, hooks);

  record.queue = queue.stats();
  record.wallMs = Date.now() - wallStart;
  return record;
}

async function decisionOutcome(db: Db, decisionId: string): Promise<string> {
  const rows = await db.execute<{ outcome: string; code: string | null }>(
    sql`select outcome, outcome_code as code from scheduler_decisions where id = ${decisionId}`,
  );
  const row = rows.rows[0];
  return row ? `${row.outcome}/${row.code ?? ""}` : "missing";
}
