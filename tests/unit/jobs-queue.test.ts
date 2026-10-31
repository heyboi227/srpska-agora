import { describe, expect, it } from "vitest";
import { MemoryJobQueue, retryDelaySeconds } from "@/lib/jobs/memory-queue";
import type { ActionJobPayload, JobSendOptions } from "@/lib/jobs/types";

const T0 = new Date("2026-11-01T10:00:00Z");

const options = (over: Partial<JobSendOptions> = {}): JobSendOptions => ({
  singletonKey: "k1",
  startAfter: T0,
  retryLimit: 2,
  retryDelaySeconds: 30,
  retryBackoff: true,
  retryDelayMaxSeconds: 900,
  expireInSeconds: 300,
  ...over,
});

const payload = (id: string): ActionJobPayload => ({
  decisionId: id,
  actionKey: `a:${id}`,
  kind: "vote",
  personaId: null,
  communityId: null,
  threadId: null,
  targetId: null,
  targetType: null,
  intent: null,
  voteValue: 1,
  topicHint: null,
  contentVersion: {},
  plannedAt: T0.toISOString(),
  notAfter: T0.toISOString(),
});

describe("retryDelaySeconds", () => {
  it("follows the pg-boss backoff formula", () => {
    expect(retryDelaySeconds(options(), 0, () => 0)).toBe(30);
    expect(retryDelaySeconds(options(), 1, () => 0)).toBe(60);
    expect(retryDelaySeconds(options(), 2, () => 0)).toBe(120);
    // random = 1 doubles the base delay.
    expect(retryDelaySeconds(options(), 0, () => 1)).toBe(60);
  });

  it("is capped by retryDelayMax and fixed without backoff", () => {
    expect(retryDelaySeconds(options(), 10, () => 1)).toBe(900);
    expect(retryDelaySeconds(options({ retryBackoff: false }), 5)).toBe(30);
  });
});

describe("MemoryJobQueue", () => {
  it("deduplicates by singleton key while a job is unfinished", async () => {
    const queue = new MemoryJobQueue();
    expect(await queue.send("vote", payload("1"), options())).not.toBeNull();
    expect(await queue.send("vote", payload("1"), options())).toBeNull();
    expect(await queue.pendingCount()).toBe(1);
    await queue.runDue(T0, async () => {}, { onDeadLetter: () => {} });
    // A finished job no longer holds the key.
    expect(await queue.send("vote", payload("1"), options())).not.toBeNull();
  });

  it("runs due jobs in startAfter order and moves the clock forward", async () => {
    const queue = new MemoryJobQueue();
    const later = new Date(T0.getTime() + 120_000);
    await queue.send(
      "vote",
      payload("late"),
      options({ singletonKey: "late", startAfter: later }),
    );
    await queue.send("vote", payload("early"), options({ singletonKey: "early" }));
    const seen: string[] = [];
    const clock: Date[] = [];
    await queue.runDue(
      new Date(T0.getTime() + 600_000),
      async (job) => {
        seen.push(job.payload.decisionId);
      },
      { setClock: (d) => clock.push(d), onDeadLetter: () => {} },
    );
    expect(seen).toEqual(["early", "late"]);
    expect(clock.at(-1)).toEqual(later);
    expect(queue.stats()).toMatchObject({ sent: 2, completed: 2, maxPending: 2 });
  });

  it("does not run jobs that are not due yet", async () => {
    const queue = new MemoryJobQueue();
    await queue.send("vote", payload("1"), options({ startAfter: new Date(T0.getTime() + 1) }));
    expect(await queue.runDue(T0, async () => {}, { onDeadLetter: () => {} })).toBe(0);
  });

  it("retries with backoff and dead-letters after the retry limit", async () => {
    const queue = new MemoryJobQueue(() => 0);
    await queue.send("vote", payload("1"), options());
    const times: number[] = [];
    const dead: string[] = [];
    let now = T0;
    await queue.runDue(
      new Date(T0.getTime() + 3600_000),
      async () => {
        times.push(now.getTime());
        throw new Error("nope");
      },
      {
        setClock: (d) => (now = d),
        onDeadLetter: (job, error) => {
          dead.push(`${job.payload.decisionId}:${(error as Error).message}`);
        },
      },
    );
    expect(times.map((t) => (t - T0.getTime()) / 1000)).toEqual([0, 30, 90]);
    expect(dead).toEqual(["1:nope"]);
    expect(queue.stats()).toMatchObject({ retries: 2, deadLetters: 1, completed: 0 });
  });

  it("schedules a retry from the failure time, not from the original start", async () => {
    const queue = new MemoryJobQueue(() => 0);
    await queue.send("vote", payload("1"), options({ retryLimit: 1 }));
    let now = T0;
    const starts: number[] = [];
    await queue.runDue(
      new Date(T0.getTime() + 3600_000),
      async () => {
        starts.push(now.getTime());
        // A slow attempt: the clock moves 100 s before the job fails.
        now = new Date(now.getTime() + 100_000);
        throw new Error("slow");
      },
      {
        setClock: (d) => (now = d),
        now: () => now,
        onDeadLetter: () => {},
      },
    );
    // First attempt at 0 s, fails at 100 s; the 30 s delay counts from the failure.
    expect(starts.map((t) => (t - T0.getTime()) / 1000)).toEqual([0, 130]);
  });

  it("redelivers a finished job's payload", async () => {
    const queue = new MemoryJobQueue();
    const id = await queue.send("vote", payload("1"), options());
    let runs = 0;
    await queue.runDue(T0, async () => void (runs += 1), { onDeadLetter: () => {} });
    await queue.redeliver(id ?? "", async () => void (runs += 1));
    expect(runs).toBe(2);
  });
});
