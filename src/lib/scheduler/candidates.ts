import type { StageFlags } from "@/lib/costs/stages";
import type { AgoraConfig } from "@/lib/config/schema";
import type { ActionKind } from "@/lib/jobs/types";
import type { Intent } from "@/lib/providers/types";
import { SeededRandom } from "@/lib/random";
import {
  personaReason,
  globalReason,
  replyReason,
  revisionReason,
  summaryReason,
  threadReason,
  voteReason,
  type ReplyTarget,
} from "./eligibility";
import type {
  PersonaInfo,
  SchedulerSnapshot,
  SnapshotComment,
  SnapshotThread,
} from "./snapshot";
import { NEGATIVE_VOTE_CHANCE, NEGATIVE_VOTE_MIN_SCORE, REPLY_INTENT_WEIGHTS } from "./weights";

const HOUR_MS = 3_600_000;

export interface Candidate {
  kind: ActionKind;
  personaId: string | null;
  communityId: string | null;
  threadId: string | null;
  targetId: string | null;
  targetType: "thread" | "comment" | null;
  /** Raw feature values by key; the weights are applied in scoring. */
  values: Record<string, number>;
  flags: StageFlags;
  voteValue: 1 | -1 | null;
  relatedCommentId: string | null;
  /** Replies and top-level comments: the target is an open question. */
  unanswered: boolean;
  /** Top-level comment on a thread (reply with no parent comment). */
  topLevel: boolean;
  /** Revisions only: the intent of the challenging reply. */
  challengeIntent: Intent | null;
  contentVersion: { threadCommentCount?: number; targetRevision?: number };
  sortKey: string;
}

const hoursSince = (now: Date, then: Date) =>
  Math.max(0, (now.getTime() - then.getTime()) / HOUR_MS);

function communityShare(snap: SchedulerSnapshot, communityId: string): number {
  return (
    (snap.communityActivity.get(communityId) ?? 0) / Math.max(1, snap.communityActivityTotal)
  );
}

/**
 * Deterministic spread of opinion: a target already scoring well draws a
 * dissenting vote from a fixed 15 % of (voter, target) pairs. Seeded by the
 * pair alone, so the same voter always judges the same target the same way.
 */
export function voteValueFor(personaId: string, targetId: string, targetScore: number): 1 | -1 {
  if (targetScore < NEGATIVE_VOTE_MIN_SCORE) return 1;
  return new SeededRandom(`vote:${personaId}:${targetId}`).chance(NEGATIVE_VOTE_CHANCE)
    ? -1
    : 1;
}

export function replyCandidates(snap: SchedulerSnapshot, config: AgoraConfig): Candidate[] {
  if (globalReason(snap, config, "reply")) return [];
  const out: Candidate[] = [];
  const targets: ReplyTarget[] = [];
  for (const thread of snap.threads) targets.push({ type: "thread", thread });
  for (const comment of snap.comments) {
    const thread = snap.threadsById.get(comment.threadId);
    if (thread) targets.push({ type: "comment", thread, comment });
  }

  for (const persona of snap.personas) {
    if (personaReason(snap, config, persona, "reply")) continue;
    for (const target of targets) {
      if (replyReason(snap, config, persona, target)) continue;
      const { thread } = target;
      const affinity = persona.affinity.get(thread.communityId) ?? 0;
      const unanswered =
        target.type === "comment"
          ? target.comment.isQuestion && target.comment.replyCount === 0
          : thread.isQuestion && thread.commentCount === 0;
      const targetId = target.type === "comment" ? target.comment.id : thread.id;
      const ownComments = snap.personaThreadComments.get(`${persona.id}:${thread.id}`) ?? 0;
      out.push({
        kind: "reply",
        personaId: persona.id,
        communityId: thread.communityId,
        threadId: thread.id,
        targetId,
        targetType: target.type,
        values: {
          unansweredQuestion: unanswered ? 1 : 0,
          freshEvidence: thread.hasFreshEvidence ? 1 : 0,
          personaRelevance: affinity / 5,
          topicDiversity: -communityShare(snap, thread.communityId),
          threadSaturation: -Math.min(1, thread.commentsLast24h / 20),
          threadRecency: Math.exp(-hoursSince(snap.now, thread.lastActivityAt) / 24),
          personaThreadShare: -(ownComments / Math.max(1, thread.commentCount)),
        },
        flags: {
          affinity,
          freshEvidence: thread.hasFreshEvidence,
          answersOpenQuestion: unanswered,
        },
        voteValue: null,
        relatedCommentId: null,
        unanswered,
        topLevel: target.type === "thread",
        challengeIntent: null,
        contentVersion: {
          threadCommentCount: thread.commentCount,
          targetRevision: target.type === "comment" ? target.comment.revision : thread.revision,
        },
        sortKey: `${persona.id}:${targetId}`,
      });
    }
  }
  return out;
}

export function threadCandidates(snap: SchedulerSnapshot, config: AgoraConfig): Candidate[] {
  if (globalReason(snap, config, "thread")) return [];
  const out: Candidate[] = [];
  for (const persona of snap.personas) {
    if (personaReason(snap, config, persona, "thread")) continue;
    for (const [communityId, affinity] of persona.affinity) {
      if (threadReason(snap, persona, communityId)) continue;
      const newest = snap.communities.get(communityId)?.newestThreadAt ?? null;
      // No thread yet counts as maximally quiet.
      const quiet = newest ? Math.min(1, hoursSince(snap.now, newest) / 24) : 1;
      out.push({
        kind: "thread",
        personaId: persona.id,
        communityId,
        threadId: null,
        targetId: null,
        targetType: null,
        values: {
          personaRelevance: affinity / 5,
          topicDiversity: -communityShare(snap, communityId),
          communityQuietness: quiet,
          freshEvidence: 0,
        },
        flags: { affinity, freshEvidence: false, answersOpenQuestion: false },
        voteValue: null,
        relatedCommentId: null,
        unanswered: false,
        topLevel: false,
        challengeIntent: null,
        contentVersion: {},
        sortKey: `${persona.id}:${communityId}`,
      });
    }
  }
  return out;
}

const CHALLENGE_PRESSURE: Partial<Record<Intent, number>> = {
  correct_earlier: 1,
  disagree: 0.6,
};

export function revisionCandidates(snap: SchedulerSnapshot, config: AgoraConfig): Candidate[] {
  if (globalReason(snap, config, "revision")) return [];
  const personasById = new Map(snap.personas.map((p) => [p.id, p]));
  // Comments arrive newest first, so the first challenge seen per parent is the newest.
  const challenge = new Map<string, SnapshotComment>();
  for (const reply of snap.comments) {
    if (!reply.parentCommentId || !reply.intent) continue;
    if (CHALLENGE_PRESSURE[reply.intent] === undefined) continue;
    const parent = snap.commentsById.get(reply.parentCommentId);
    if (!parent || parent.authorPersonaId === reply.authorPersonaId) continue;
    // Not yet answered by a revision: the parent has not changed since the challenge.
    if (parent.updatedAt >= reply.createdAt) continue;
    if (!challenge.has(parent.id)) challenge.set(parent.id, reply);
  }

  const out: Candidate[] = [];
  for (const [parentId, reply] of challenge) {
    const parent = snap.commentsById.get(parentId);
    const persona = parent ? personasById.get(parent.authorPersonaId) : undefined;
    const thread = parent ? snap.threadsById.get(parent.threadId) : undefined;
    if (!parent || !persona || !thread || !reply.intent) continue;
    if (personaReason(snap, config, persona, "revision")) continue;
    if (revisionReason(snap, persona, parent)) continue;
    out.push({
      kind: "revision",
      personaId: persona.id,
      communityId: thread.communityId,
      threadId: thread.id,
      targetId: parent.id,
      targetType: "comment",
      values: {
        correctionPressure: CHALLENGE_PRESSURE[reply.intent] ?? 0,
        challengeRecency: Math.exp(-hoursSince(snap.now, reply.createdAt) / 12),
      },
      flags: {
        affinity: persona.affinity.get(thread.communityId) ?? 0,
        freshEvidence: thread.hasFreshEvidence,
        answersOpenQuestion: false,
      },
      voteValue: null,
      relatedCommentId: reply.id,
      unanswered: false,
      topLevel: false,
      challengeIntent: reply.intent,
      contentVersion: {
        threadCommentCount: thread.commentCount,
        targetRevision: parent.revision,
      },
      sortKey: `${persona.id}:${parent.id}`,
    });
  }
  return out;
}

export function voteCandidates(snap: SchedulerSnapshot, config: AgoraConfig): Candidate[] {
  if (globalReason(snap, config, "vote")) return [];
  const out: Candidate[] = [];
  interface VoteTarget {
    type: "thread" | "comment";
    id: string;
    authorPersonaId: string;
    thread: SnapshotThread;
    createdAt: Date;
    score: number;
    revision: number;
  }
  const targets: VoteTarget[] = [];
  for (const thread of snap.threads) {
    targets.push({
      type: "thread",
      id: thread.id,
      authorPersonaId: thread.authorPersonaId,
      thread,
      createdAt: thread.createdAt,
      score: thread.score,
      revision: thread.revision,
    });
  }
  for (const comment of snap.comments) {
    const thread = snap.threadsById.get(comment.threadId);
    if (!thread) continue;
    targets.push({
      type: "comment",
      id: comment.id,
      authorPersonaId: comment.authorPersonaId,
      thread,
      createdAt: comment.createdAt,
      score: comment.score,
      revision: comment.revision,
    });
  }

  for (const persona of snap.personas) {
    if (personaReason(snap, config, persona, "vote")) continue;
    for (const t of targets) {
      const communityId = t.thread.communityId;
      if (
        voteReason(snap, persona, { id: t.id, authorPersonaId: t.authorPersonaId, communityId })
      ) {
        continue;
      }
      const affinity = persona.affinity.get(communityId) ?? 0;
      out.push({
        kind: "vote",
        personaId: persona.id,
        communityId,
        threadId: t.thread.id,
        targetId: t.id,
        targetType: t.type,
        values: {
          personaRelevance: affinity / 5,
          recency: Math.exp(-hoursSince(snap.now, t.createdAt) / 24),
          quality: Math.tanh(t.score / 5),
        },
        flags: { affinity, freshEvidence: false, answersOpenQuestion: false },
        voteValue: voteValueFor(persona.id, t.id, t.score),
        relatedCommentId: null,
        unanswered: false,
        topLevel: false,
        challengeIntent: null,
        contentVersion: { targetRevision: t.revision },
        sortKey: `${persona.id}:${t.id}`,
      });
    }
  }
  return out;
}

/** Threads whose summary lags by at least `summaryEveryComments` comments. */
export function dueSummaryThreads(
  snap: SchedulerSnapshot,
  config: AgoraConfig,
): SnapshotThread[] {
  return snap.threads.filter(
    (t) =>
      t.commentCount - t.summaryCovers >= config.scheduler.summaryEveryComments &&
      !summaryReason(snap, t),
  );
}

export function summaryCandidates(snap: SchedulerSnapshot, config: AgoraConfig): Candidate[] {
  if (globalReason(snap, config, "summary")) return [];
  return dueSummaryThreads(snap, config).map((thread) => ({
    kind: "summary" as const,
    personaId: null,
    communityId: thread.communityId,
    threadId: thread.id,
    targetId: thread.id,
    targetType: "thread" as const,
    values: {
      backlog: Math.min(
        2,
        (thread.commentCount - thread.summaryCovers) / config.scheduler.summaryEveryComments,
      ),
    },
    flags: { affinity: 0, freshEvidence: thread.hasFreshEvidence, answersOpenQuestion: false },
    voteValue: null,
    relatedCommentId: null,
    unanswered: false,
    topLevel: false,
    challengeIntent: null,
    contentVersion: {
      threadCommentCount: thread.commentCount,
      targetRevision: thread.revision,
    },
    sortKey: thread.id,
  }));
}

export function buildCandidates(
  kind: ActionKind,
  snap: SchedulerSnapshot,
  config: AgoraConfig,
): Candidate[] {
  switch (kind) {
    case "reply":
      return replyCandidates(snap, config);
    case "thread":
      return threadCandidates(snap, config);
    case "revision":
      return revisionCandidates(snap, config);
    case "vote":
      return voteCandidates(snap, config);
    case "summary":
      return summaryCandidates(snap, config);
  }
}

function weightedPick<T>(items: readonly (readonly [T, number])[], rng: SeededRandom): T {
  const total = items.reduce((acc, [, w]) => acc + w, 0);
  let point = rng.next() * total;
  for (const [item, weight] of items) {
    if (point < weight) return item;
    point -= weight;
  }
  return (items[items.length - 1] as readonly [T, number])[0];
}

/** Intent and topic hint for a chosen candidate; seeded, so the same slot always yields the same text plan. */
export function finalizeIntent(
  c: Candidate,
  persona: PersonaInfo | null,
  rng: SeededRandom,
): { intent: Intent | null; topicHint: string | null } {
  switch (c.kind) {
    case "reply":
      if (c.unanswered) return { intent: "answer_question", topicHint: null };
      if (c.topLevel) {
        return { intent: rng.chance(0.5) ? "ask_question" : "add_context", topicHint: null };
      }
      return { intent: weightedPick(REPLY_INTENT_WEIGHTS, rng), topicHint: null };
    case "thread": {
      const intent: Intent = rng.chance(0.5) ? "introduce_topic" : "ask_question";
      const interests = persona?.interests ?? [];
      return { intent, topicHint: interests.length > 0 ? rng.pick(interests) : null };
    }
    case "revision":
      return { intent: "correct_earlier", topicHint: null };
    case "summary":
      return { intent: "summarize", topicHint: null };
    case "vote":
      return { intent: null, topicHint: null };
  }
}
