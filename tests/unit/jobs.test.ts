import { describe, expect, it } from "vitest";
import { STANDARD_PRESET } from "@/lib/config/presets";
import { Semaphore } from "@/lib/jobs/semaphore";
import { jobOptionsFor } from "@/lib/jobs/types";

describe("jobOptionsFor", () => {
  const startAfter = new Date("2026-11-01T10:00:00Z");

  it("derives retries from the configured attempt limit", () => {
    const o = jobOptionsFor("reply", STANDARD_PRESET, "key-1", startAfter);
    expect(o).toEqual({
      singletonKey: "key-1",
      startAfter,
      retryLimit: STANDARD_PRESET.runtime.maxAutomaticJobAttempts - 1,
      retryDelaySeconds: 30,
      retryBackoff: true,
      retryDelayMaxSeconds: 900,
      expireInSeconds: 300,
    });
  });

  it("gives every content kind five minutes for three gateway calls", () => {
    for (const kind of ["thread", "reply", "revision", "summary"] as const) {
      expect(jobOptionsFor(kind, STANDARD_PRESET, "k", startAfter).expireInSeconds).toBe(300);
    }
  });

  it("expires votes sooner", () => {
    expect(jobOptionsFor("vote", STANDARD_PRESET, "k", startAfter).expireInSeconds).toBe(30);
  });
});

describe("Semaphore", () => {
  const deferred = () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => (release = resolve));
    return { promise, release };
  };
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it("never runs more tasks at once than its limit and starts waiters in order", async () => {
    const sem = new Semaphore(2);
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    let peak = 0;
    const runs = gates.map((gate, index) =>
      sem.run(async () => {
        started.push(index);
        peak = Math.max(peak, sem.inUse);
        await gate.promise;
      }),
    );
    await tick();
    expect(started).toEqual([0, 1]);
    gates[0]!.release();
    await tick();
    expect(started).toEqual([0, 1, 2]);
    gates[1]!.release();
    gates[2]!.release();
    await Promise.all(runs);
    expect(peak).toBe(2);
    expect(sem.inUse).toBe(0);
  });

  it("frees the slot when a task throws", async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(sem.inUse).toBe(0);
    await expect(sem.run(async () => "ok")).resolves.toBe("ok");
  });

  it("starts waiters when the limit is raised", async () => {
    const sem = new Semaphore(1);
    const first = deferred();
    const second = deferred();
    const started: string[] = [];
    const a = sem.run(async () => {
      started.push("a");
      await first.promise;
    });
    const b = sem.run(async () => {
      started.push("b");
      await second.promise;
    });
    await tick();
    expect(started).toEqual(["a"]);
    sem.setLimit(2);
    await tick();
    expect(started).toEqual(["a", "b"]);
    first.release();
    second.release();
    await Promise.all([a, b]);
  });

  it("rejects a limit below one", () => {
    expect(() => new Semaphore(0)).toThrow(RangeError);
  });
});
