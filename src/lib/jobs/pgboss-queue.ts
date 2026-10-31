import type { PgBoss, SendOptions } from "pg-boss";
import type { AgoraConfig } from "@/lib/config/schema";
import {
  ACTION_QUEUES,
  DEAD_LETTER_QUEUE,
  type ActionJobPayload,
  type ActionKind,
  type JobQueue,
  type JobSendOptions,
} from "./types";

const DAY_SECONDS = 86_400;
/** A job nobody picked up in two days is long stale (jobs go stale within minutes). */
const QUEUED_RETENTION_SECONDS = 2 * DAY_SECONDS;

/**
 * Retention in pg-boss 12: `deleteAfterSeconds` removes any finished job
 * (completed or failed; both have completed_on) that long after it ended, and
 * `retentionSeconds` removes jobs that stayed created or retry for too long.
 * A failed action job is copied into the dead-letter queue, so the action
 * queues keep finished jobs for completedJobRetentionDays, and the dead-letter
 * queue, where every failure ends up, keeps them for failedJobRetentionDays.
 */
function queueOptions(config: AgoraConfig) {
  const failedSeconds = config.storage.failedJobRetentionDays * DAY_SECONDS;
  return {
    action: {
      deleteAfterSeconds: config.storage.completedJobRetentionDays * DAY_SECONDS,
      retentionSeconds: QUEUED_RETENTION_SECONDS,
    },
    dead: { deleteAfterSeconds: failedSeconds, retentionSeconds: failedSeconds },
  };
}

/**
 * The production queue. Action queues use the "exclusive" policy: at most one
 * created, retry or active job per singletonKey, so a re-sent decision returns
 * null instead of running twice. Finished jobs do not hold the key.
 */
export class PgBossJobQueue implements JobQueue {
  constructor(private readonly boss: PgBoss) {}

  async ensureQueues(config: AgoraConfig): Promise<void> {
    const options = queueOptions(config);
    // The dead-letter queue must exist before any queue names it.
    await this.boss.createQueue(DEAD_LETTER_QUEUE, { policy: "standard", ...options.dead });
    await this.boss.updateQueue(DEAD_LETTER_QUEUE, options.dead);
    for (const name of Object.values(ACTION_QUEUES)) {
      await this.boss.createQueue(name, {
        policy: "exclusive",
        deadLetter: DEAD_LETTER_QUEUE,
        ...options.action,
      });
      // Retention may have changed in the configuration since the queue was created.
      await this.boss.updateQueue(name, options.action);
    }
  }

  async send(
    kind: ActionKind,
    payload: ActionJobPayload,
    options: JobSendOptions,
  ): Promise<string | null> {
    const sendOptions: SendOptions = {
      singletonKey: options.singletonKey,
      startAfter: options.startAfter,
      retryLimit: options.retryLimit,
      retryDelay: options.retryDelaySeconds,
      retryBackoff: options.retryBackoff,
      // pg-boss rejects a delay cap on a job without backoff.
      ...(options.retryBackoff ? { retryDelayMax: options.retryDelayMaxSeconds } : {}),
      expireInSeconds: options.expireInSeconds,
    };
    return this.boss.send(ACTION_QUEUES[kind], payload, sendOptions);
  }

  /**
   * Queued (created and retry, including deferred) plus active jobs. pg-boss
   * refreshes these counters on its monitor interval, so the figure can lag by
   * about a minute, which is plenty for back-pressure.
   */
  async pendingCount(): Promise<number> {
    let total = 0;
    for (const name of Object.values(ACTION_QUEUES)) {
      const [stats] = await this.boss.getQueueStats(name);
      if (stats) total += stats.queuedCount + stats.activeCount;
    }
    return total;
  }
}
