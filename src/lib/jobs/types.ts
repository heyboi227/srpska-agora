import type { AgoraConfig } from "@/lib/config/schema";
import type { Intent } from "@/lib/providers/types";

export type ActionKind = "thread" | "reply" | "revision" | "summary" | "vote";

export const ACTION_QUEUES: Record<ActionKind, string> = {
  thread: "action-thread",
  reply: "action-reply",
  revision: "action-revision",
  summary: "action-summary",
  vote: "action-vote",
};

export const DEAD_LETTER_QUEUE = "action-dead";

/** What the scheduler enqueues; JSON-safe, so times are ISO strings. */
export interface ActionJobPayload {
  decisionId: string;
  actionKey: string;
  kind: ActionKind;
  personaId: string | null;
  communityId: string | null;
  threadId: string | null;
  targetId: string | null;
  targetType: "thread" | "comment" | null;
  intent: Intent | null;
  voteValue: 1 | -1 | null;
  topicHint: string | null;
  /** Revisions: the reply that challenged the content being revised. */
  relatedCommentId?: string | null;
  contentVersion: { threadCommentCount?: number; targetRevision?: number };
  plannedAt: string;
  notAfter: string;
}

export interface JobSendOptions {
  singletonKey: string;
  startAfter: Date;
  retryLimit: number;
  retryDelaySeconds: number;
  retryBackoff: boolean;
  retryDelayMaxSeconds: number;
  expireInSeconds: number;
}

export interface JobQueue {
  /** Returns the job id, or null when the singleton key deduplicated the send. */
  send(
    kind: ActionKind,
    payload: ActionJobPayload,
    options: JobSendOptions,
  ): Promise<string | null>;
  /** Queued + retrying + active jobs over all action queues. */
  pendingCount(): Promise<number>;
}

export function jobOptionsFor(
  kind: ActionKind,
  config: AgoraConfig,
  singletonKey: string,
  startAfter: Date,
): JobSendOptions {
  return {
    singletonKey,
    startAfter,
    retryLimit: config.runtime.maxAutomaticJobAttempts - 1,
    retryDelaySeconds: 30,
    retryBackoff: true,
    retryDelayMaxSeconds: 900,
    expireInSeconds: kind === "vote" ? 30 : 300,
  };
}
