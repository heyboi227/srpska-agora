import { eq, sql } from "drizzle-orm";
import { PgBoss, type JobWithMetadata } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadDotEnv } from "@/lib/env";
import { recordDeadLetter } from "@/lib/jobs/dead-letter";
import { PgBossJobQueue } from "@/lib/jobs/pgboss-queue";
import {
  ACTION_QUEUES,
  DEAD_LETTER_QUEUE,
  jobOptionsFor,
  type ActionJobPayload,
} from "@/lib/jobs/types";
import { schedulerDecisions } from "@/lib/db/schema";
import { jobHarness } from "./jobs-fixture";
import { testDb } from "./helpers";

const db = testDb();
// Its own schema, so this test never touches the worker's "pgboss" tables.
const SCHEMA = "pgboss_test_jobs";

loadDotEnv();
let boss: PgBoss;

beforeAll(async () => {
  await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`));
  boss = new PgBoss({
    connectionString: process.env.DATABASE_URL_TEST ?? "",
    schema: SCHEMA,
    application_name: "srpska-agora-test",
    max: 4,
  });
  boss.on("error", () => {});
  await boss.start();
});

afterAll(async () => {
  await boss.stop({ graceful: false, timeout: 5000 });
  await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`));
});

describe("real pg-boss", () => {
  it("creates the queues, dedupes by singleton key, and routes an exhausted job to the dead-letter path", async () => {
    const h = await jobHarness(db);
    const queue = new PgBossJobQueue(boss);
    await queue.ensureQueues(h.config);
    // Running it twice must be harmless (the worker does so on every start).
    await queue.ensureQueues(h.config);

    const queues = (await boss.getQueues()).map((q) => q.name);
    expect(queues).toEqual(
      expect.arrayContaining([DEAD_LETTER_QUEUE, ...Object.values(ACTION_QUEUES)]),
    );
    const voteQueue = await boss.getQueue(ACTION_QUEUES.vote);
    expect(voteQueue).toMatchObject({
      policy: "exclusive",
      deadLetter: DEAD_LETTER_QUEUE,
      deleteAfterSeconds: h.config.storage.completedJobRetentionDays * 86_400,
    });
    expect((await boss.getQueue(DEAD_LETTER_QUEUE))?.deleteAfterSeconds).toBe(
      h.config.storage.failedJobRetentionDays * 86_400,
    );

    const payload = await h.plan("vote", {
      personaId: h.people.personaAId,
      targetType: "comment",
      targetId: h.commentId,
      voteValue: 1,
    });
    // One retry after one second, so the whole path takes a few seconds.
    const options = {
      ...jobOptionsFor("vote", h.config, payload.actionKey, new Date()),
      retryLimit: 1,
      retryDelaySeconds: 1,
      retryBackoff: false,
    };
    const jobId = await queue.send("vote", payload, options);
    expect(jobId).not.toBeNull();
    // Same key while the first is unfinished: deduplicated.
    expect(await queue.send("vote", payload, options)).toBeNull();

    let attempts = 0;
    await boss.work(
      ACTION_QUEUES.vote,
      { batchSize: 1, pollingIntervalSeconds: 0.5 },
      async () => {
        attempts += 1;
        throw new Error("always fails");
      },
    );
    await boss.work(
      DEAD_LETTER_QUEUE,
      { batchSize: 1, pollingIntervalSeconds: 0.5, includeMetadata: true },
      async (jobs: JobWithMetadata<ActionJobPayload>[]) => {
        for (const job of jobs) {
          const output = job.output as { message?: string } | null;
          await recordDeadLetter(db, h.clock, job.data, output?.message ?? "failed");
        }
      },
    );

    const deadline = Date.now() + 15_000;
    let outcome = "queued";
    while (Date.now() < deadline && outcome === "queued") {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const [row] = await db
        .select({ outcome: schedulerDecisions.outcome })
        .from(schedulerDecisions)
        .where(eq(schedulerDecisions.id, payload.decisionId));
      outcome = row?.outcome ?? "queued";
    }
    expect(outcome).toBe("failed");
    expect(attempts).toBe(2);
    const [decision] = await db
      .select()
      .from(schedulerDecisions)
      .where(eq(schedulerDecisions.id, payload.decisionId));
    expect(decision?.outcomeCode).toBe("dead_letter");
  }, 30_000);
});
