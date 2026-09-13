import { hostname } from "node:os";
import { PgBoss } from "pg-boss";
import { getActiveConfig } from "@/lib/config/service";
import { getDb, getDbHandle } from "@/lib/db/client";
import { workerHeartbeats } from "@/lib/db/schema";
import { getEnv, loadDotEnv } from "@/lib/env";

/**
 * The persistent worker. Phase 1 ships the skeleton: a pg-boss instance in its
 * own schema, a scheduled tick every minute, and a heartbeat the admin area
 * shows. The tick reads configuration and deliberately does nothing else yet;
 * Phase 2 adds work selection, budget reservations, and the action jobs.
 */

const WORKER_VERSION = "0.1.0-phase1";
const TICK_QUEUE = "scheduler-tick";
const HEARTBEAT_MS = 30_000;

const workerId = `${hostname()}:${process.pid}`;

async function heartbeat(details: Record<string, unknown>): Promise<void> {
  const db = getDb();
  const now = new Date();
  await db
    .insert(workerHeartbeats)
    .values({
      workerId,
      hostname: hostname(),
      version: WORKER_VERSION,
      startedAt: now,
      lastSeenAt: now,
      details,
    })
    .onConflictDoUpdate({
      target: workerHeartbeats.workerId,
      set: { lastSeenAt: now, version: WORKER_VERSION, details },
    });
}

async function tick(): Promise<void> {
  const config = await getActiveConfig(getDb());
  const state = config.runtime.pauseAllActions
    ? "paused"
    : config.runtime.pausePaidActions
      ? "paid-paused"
      : "active";
  // Phase 2 replaces this log line with work selection.
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      event: "tick",
      state,
      mode: config.runtime.mode,
      preset: config.preset,
    }),
  );
  await heartbeat({ lastTickAt: new Date().toISOString(), state, mode: config.runtime.mode });
}

async function main(): Promise<void> {
  loadDotEnv();
  const env = getEnv();
  const boss = new PgBoss({
    connectionString: env.DATABASE_URL,
    schema: "pgboss",
    application_name: "srpska-agora-worker",
    max: 3,
  });
  boss.on("error", (error: unknown) =>
    console.error(JSON.stringify({ event: "pg-boss-error", message: String(error) })),
  );

  await boss.start();
  await boss.createQueue(TICK_QUEUE, {
    policy: "singleton",
    retryLimit: 0,
    expireInSeconds: 120,
    retentionSeconds: 3600,
  });
  await boss.schedule(TICK_QUEUE, "* * * * *", {}, { tz: "Europe/Belgrade" });
  await boss.work(TICK_QUEUE, { batchSize: 1, pollingIntervalSeconds: 5 }, async () => {
    await tick();
  });

  await heartbeat({ state: "starting" });
  const timer = setInterval(() => {
    heartbeat({ state: "idle" }).catch((error: unknown) =>
      console.error(JSON.stringify({ event: "heartbeat-error", message: String(error) })),
    );
  }, HEARTBEAT_MS);

  console.log(JSON.stringify({ event: "worker-started", workerId, version: WORKER_VERSION }));

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(JSON.stringify({ event: "worker-stopping", signal }));
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
