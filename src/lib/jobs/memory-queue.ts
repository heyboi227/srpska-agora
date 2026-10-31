import { randomUUID } from "node:crypto";
import type { ActionJobPayload, ActionKind, JobQueue, JobSendOptions } from "./types";

export interface MemoryJob {
  id: string;
  kind: ActionKind;
  payload: ActionJobPayload;
  options: JobSendOptions;
  state: "queued" | "retry" | "active" | "completed" | "failed";
  /** Failed attempts so far; pg-boss calls this retryCount. */
  retryCount: number;
  startAfter: Date;
  lastError: string | null;
}

export interface MemoryQueueStats {
  sent: number;
  completed: number;
  retries: number;
  deadLetters: number;
  maxPending: number;
}

export interface RunHooks {
  /** Moves the simulated clock before each job; it never goes backwards. */
  setClock?(date: Date): void;
  /** The current simulated time; a failed job retries this long after the failure, not after its old start. */
  now?(): Date;
  onDeadLetter(job: MemoryJob, error: unknown): void | Promise<void>;
}

type Handler = (job: MemoryJob, attempt: number) => Promise<unknown>;

/**
 * pg-boss 12's retry delay (manager.js, failJobs): with backoff it is
 *   min(retryDelayMax, max(retryDelay, 1) * (2^e / 2 + 2^e / 2 * random)),
 *   e = min(16, retryCount + 1),
 * where retryCount counts the failures before this one; without backoff it is retryDelay.
 */
export function retryDelaySeconds(
  options: Pick<JobSendOptions, "retryDelaySeconds" | "retryBackoff" | "retryDelayMaxSeconds">,
  retryCount: number,
  random: () => number = Math.random,
): number {
  if (!options.retryBackoff) return options.retryDelaySeconds;
  const exp = Math.min(16, retryCount + 1);
  const half = 2 ** exp / 2;
  const delay = Math.max(options.retryDelaySeconds, 1) * (half + half * random());
  return Math.min(options.retryDelayMaxSeconds, delay);
}

/** An in-process stand-in for pg-boss, for tests and the simulation. */
export class MemoryJobQueue implements JobQueue {
  private readonly jobs: MemoryJob[] = [];
  private readonly counters: MemoryQueueStats = {
    sent: 0,
    completed: 0,
    retries: 0,
    deadLetters: 0,
    maxPending: 0,
  };

  constructor(private readonly random: () => number = Math.random) {}

  async send(
    kind: ActionKind,
    payload: ActionJobPayload,
    options: JobSendOptions,
  ): Promise<string | null> {
    // Like an "exclusive" pg-boss queue: one unfinished job per singleton key.
    const duplicate = this.jobs.some(
      (j) =>
        j.kind === kind &&
        j.options.singletonKey === options.singletonKey &&
        (j.state === "queued" || j.state === "retry" || j.state === "active"),
    );
    if (duplicate) return null;
    const job: MemoryJob = {
      id: randomUUID(),
      kind,
      payload,
      options,
      state: "queued",
      retryCount: 0,
      startAfter: options.startAfter,
      lastError: null,
    };
    this.jobs.push(job);
    this.counters.sent += 1;
    this.counters.maxPending = Math.max(this.counters.maxPending, this.unfinished());
    return job.id;
  }

  async pendingCount(): Promise<number> {
    return this.unfinished();
  }

  private unfinished(): number {
    return this.jobs.filter((j) => j.state === "queued" || j.state === "retry").length;
  }

  stats(): MemoryQueueStats {
    return { ...this.counters };
  }

  all(): readonly MemoryJob[] {
    return this.jobs;
  }

  /**
   * Runs every job due at or before `until` in startAfter order, including
   * retries that fall due on the way. Each job moves the clock to its start
   * time when that is later than the current time.
   */
  async runDue(until: Date, handler: Handler, hooks: RunHooks): Promise<number> {
    let ran = 0;
    for (;;) {
      const due = this.jobs
        .filter(
          (j) =>
            (j.state === "queued" || j.state === "retry") &&
            j.startAfter.getTime() <= until.getTime(),
        )
        // Ties keep insertion order (sort is stable), so a run is repeatable.
        .sort((a, b) => a.startAfter.getTime() - b.startAfter.getTime())[0];
      if (!due) return ran;
      hooks.setClock?.(due.startAfter);
      due.state = "active";
      ran += 1;
      try {
        await handler(due, due.retryCount + 1);
        due.state = "completed";
        this.counters.completed += 1;
      } catch (error) {
        due.lastError = error instanceof Error ? error.message : String(error);
        if (due.retryCount < due.options.retryLimit) {
          const delay = retryDelaySeconds(due.options, due.retryCount, this.random);
          due.retryCount += 1;
          due.state = "retry";
          const failedAt = hooks.now?.() ?? due.startAfter;
          due.startAfter = new Date(failedAt.getTime() + delay * 1000);
          this.counters.retries += 1;
        } else {
          due.state = "failed";
          this.counters.deadLetters += 1;
          await hooks.onDeadLetter(due, error);
        }
      }
    }
  }

  /** Runs the payload of a finished job again, as a duplicate delivery would. */
  async redeliver(jobId: string, handler: Handler): Promise<void> {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) throw new Error(`No job ${jobId}`);
    await handler(job, job.retryCount + 1);
  }
}
