import { hostname } from "node:os";
import { PgBoss, type JobWithMetadata } from "pg-boss";
import { DbTimeClock } from "@/lib/clock";
import type { AgoraConfig } from "@/lib/config/schema";
import { getActiveConfig } from "@/lib/config/service";
import { getBudgetStatus, type BudgetStage } from "@/lib/costs";
import { getDb, getDbHandle } from "@/lib/db/client";
import { schedulerRuns, workerHeartbeats } from "@/lib/db/schema";
import { buildServiceContext } from "@/lib/domain/context";
import { getEnv, loadDotEnv } from "@/lib/env";
import { CLEANUP_SCHEDULE, runCleanup } from "@/lib/jobs/cleanup";
import { recordDeadLetter } from "@/lib/jobs/dead-letter";
import { executeActionJob } from "@/lib/jobs/handlers";
import { PgBossJobQueue } from "@/lib/jobs/pgboss-queue";
import { Semaphore } from "@/lib/jobs/semaphore";
import {
  ACTION_QUEUES,
  DEAD_LETTER_QUEUE,
  type ActionJobPayload,
  type ActionKind,
} from "@/lib/jobs/types";
import { runSchedulerTick } from "@/lib/scheduler";

/**
 * The persistent worker: a pg-boss instance in its own schema that runs the
 * scheduler tick every minute, executes the planned action jobs, records dead
 * letters, and performs the scheduled cleanups. Everything it does is logged
 * as one JSON line per event and summarised in the heartbeat the admin shows.
 */

const WORKER_VERSION = "0.2.0-phase2";
const TICK_QUEUE = "scheduler-tick";
const HEARTBEAT_MS = 30_000;
const TIMEZONE = "Europe/Belgrade";

const workerId = `${hostname()}:${process.pid}`;

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
}

/** Short, secret-free text for logs and audit rows. */
function shortError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, "[redacted]").slice(0, 300);
}

/** The last tick's summary, kept so the periodic heartbeat does not erase it. */
let lastSummary: Record<string, unknown> = {};

async function heartbeat(details: Record<string, unknown>): Promise<void> {
  const db = getDb();
  const now = new Date();
  lastSummary = { ...lastSummary, ...details };
  await db
    .insert(workerHeartbeats)
    .values({
      workerId,
      hostname: hostname(),
      version: WORKER_VERSION,
      startedAt: now,
      lastSeenAt: now,
      details: lastSummary,
    })
    .onConflictDoUpdate({
      target: workerHeartbeats.workerId,
      set: { lastSeenAt: now, version: WORKER_VERSION, details: lastSummary },
    });
}

/** A failed planning pass leaves a visible trace and never stops the worker. */
async function recordTickError(
  config: AgoraConfig,
  clock: DbTimeClock,
  error: unknown,
): Promise<BudgetStage> {
  const db = getDb();
  let stage: BudgetStage = "normal";
  try {
    stage = (await getBudgetStatus(db, config, clock)).stage;
  } catch {
    // Keep the default; the stage is context, not the point.
  }
  try {
    const now = clock.now();
    await db.insert(schedulerRuns).values({
      tickAt: now,
      createdAt: now,
      state: "error",
      budgetStage: stage,
      details: { error: shortError(error) },
    });
  } catch (writeError) {
    log("tick-error-record-failed", { message: shortError(writeError) });
  }
  return stage;
}

async function main(): Promise<void> {
  loadDotEnv();
  const env = getEnv();
  const db = getDb();
  const clock = new DbTimeClock(db);
  await clock.sync();

  const boss = new PgBoss({
    connectionString: env.DATABASE_URL,
    schema: "pgboss",
    application_name: "srpska-agora-worker",
    max: 6,
  });
  boss.on("error", (error: unknown) =>
    console.error(JSON.stringify({ event: "pg-boss-error", message: String(error) })),
  );
  await boss.start();

  const queue = new PgBossJobQueue(boss);
  const startConfig = await getActiveConfig(db);
  await queue.ensureQueues(startConfig);

  // Scheduler tick.
  await boss.createQueue(TICK_QUEUE, {
    policy: "singleton",
    retryLimit: 0,
    expireInSeconds: 120,
    retentionSeconds: 3600,
  });
  await boss.schedule(TICK_QUEUE, "* * * * *", {}, { tz: TIMEZONE });
  await boss.work(TICK_QUEUE, { batchSize: 1, pollingIntervalSeconds: 5 }, async () => {
    await clock.syncIfStale();
    const config = await getActiveConfig(db);
    try {
      const result = await runSchedulerTick({ db, config, clock, queue });
      const summary = {
        lastTickAt: clock.now().toISOString(),
        state: result.state,
        stage: result.stage,
        planned: result.decisions.length,
        idle: result.idleSlots,
        mode: config.runtime.mode,
      };
      log("tick", summary);
      await heartbeat(summary);
    } catch (error) {
      const stage = await recordTickError(config, clock, error);
      log("tick-error", { stage, message: shortError(error) });
      await heartbeat({
        lastTickAt: clock.now().toISOString(),
        state: "error",
        stage,
        mode: config.runtime.mode,
      });
    }
  });

  // Action jobs, one queue per kind. Votes make no model call, so one at a time is enough.
  // Each content queue runs one job at a time, and all content jobs in this process share
  // one limiter sized by runtime.maxConcurrentPaidCalls, so the paid-call slots are never
  // oversubscribed by the number of queues.
  const contentSlots = new Semaphore(startConfig.runtime.maxConcurrentPaidCalls);
  for (const kind of Object.keys(ACTION_QUEUES) as ActionKind[]) {
    await boss.work(
      ACTION_QUEUES[kind],
      { batchSize: 1, localConcurrency: 1, includeMetadata: true },
      async (jobs: JobWithMetadata<ActionJobPayload>[]) => {
        for (const job of jobs) {
          const run = async () => {
            await clock.syncIfStale();
            const config = await getActiveConfig(db);
            return executeActionJob(job.data, {
              db,
              clock,
              loadConfig: () => getActiveConfig(db),
              buildContext: (fresh) =>
                buildServiceContext({ db, config: fresh, clock, origin: "scheduler" }),
              attempt: job.retryCount + 1,
              maxAttempts: config.runtime.maxAutomaticJobAttempts,
            });
          };
          let outcome;
          if (kind === "vote") {
            outcome = await run();
          } else {
            contentSlots.setLimit((await getActiveConfig(db)).runtime.maxConcurrentPaidCalls);
            outcome = await contentSlots.run(run);
          }
          log("action", {
            kind,
            decisionId: job.data.decisionId,
            attempt: job.retryCount + 1,
            ...outcome,
          });
        }
      },
    );
  }

  // Jobs that used every attempt arrive here with the original payload and the error as output.
  await boss.work(
    DEAD_LETTER_QUEUE,
    { batchSize: 1, includeMetadata: true },
    async (jobs: JobWithMetadata<ActionJobPayload>[]) => {
      for (const job of jobs) {
        const output = job.output as { message?: string } | null;
        const message = output?.message ?? "job failed after all attempts";
        await recordDeadLetter(db, clock, job.data, message);
        log("dead-letter", {
          decisionId: job.data.decisionId,
          kind: job.data.kind,
          message: message.slice(0, 200),
        });
      }
    },
  );

  // Cleanup jobs on Belgrade-time schedules, each on its own singleton queue.
  for (const { name, cron } of CLEANUP_SCHEDULE) {
    await boss.createQueue(name, {
      policy: "singleton",
      retryLimit: 1,
      expireInSeconds: 300,
      retentionSeconds: 3600,
      deleteAfterSeconds: startConfig.storage.completedJobRetentionDays * 86_400,
    });
    await boss.schedule(name, cron, {}, { tz: TIMEZONE });
    await boss.work(name, { batchSize: 1, pollingIntervalSeconds: 10 }, async () => {
      await clock.syncIfStale();
      const config = await getActiveConfig(db);
      const counts = await runCleanup(name, { db, config, clock });
      log("cleanup", { job: name, ...counts });
    });
  }

  await heartbeat({ state: "starting" });
  const timer = setInterval(() => {
    heartbeat({}).catch((error: unknown) =>
      console.error(JSON.stringify({ event: "heartbeat-error", message: String(error) })),
    );
  }, HEARTBEAT_MS);

  log("worker-started", { workerId, version: WORKER_VERSION });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("worker-stopping", { signal });
    clearInterval(timer);
    try {
      await boss.stop({ graceful: true, timeout: 20_000 });
    } finally {
      await getDbHandle().close();
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
