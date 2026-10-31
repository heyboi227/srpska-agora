import type { AgoraConfig } from "@/lib/config/schema";
import type { ActionKind } from "@/lib/jobs/types";
import { dailyMaxFor } from "./pacing";
import {
  usageOf,
  type PersonaInfo,
  type SchedulerSnapshot,
  type SnapshotComment,
  type SnapshotThread,
} from "./snapshot";
import { MAX_REVISION_NUMBER } from "./weights";

/** Why a candidate was removed. Tests assert these codes. */
export type IneligibleReason =
  | "persona_suspended"
  | "outside_active_hours"
  | "persona_daily_cap"
  | "persona_vote_cap"
  | "cooldown"
  | "global_daily_cap"
  | "not_member"
  | "community_inactive"
  | "low_affinity"
  | "depth_limit"
  | "own_comment"
  | "pair_chain"
  | "pair_cooldown"
  | "thread_contribution_cap"
  | "reply_in_flight"
  | "not_author"
  | "revision_limit"
  | "revision_in_flight"
  | "own_content"
  | "already_voted"
  | "summary_in_flight"
  | "stage_zero";

/** True when `hour` lies in [from, to), wrapping past midnight when from > to; from === to means all day. */
export function isWithinActiveHours(hour: number, from: number, to: number): boolean {
  if (from === to) return true;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

/** Per-persona vote allowance: twice the even share of the global daily maximum. */
export function voteCapPerPersona(maxVotesPerDay: number, activePersonas: number): number {
  return Math.ceil((2 * maxVotesPerDay) / Math.max(1, activePersonas));
}

/** Limits that depend only on the persona and the kind of action. */
export function personaReason(
  snap: SchedulerSnapshot,
  config: AgoraConfig,
  persona: PersonaInfo,
  kind: ActionKind,
): IneligibleReason | null {
  if (persona.isSuspended) return "persona_suspended";
  const { from, to } = persona.limits.activeHours;
  if (!isWithinActiveHours(snap.hour, from, to)) return "outside_active_hours";
  const usage = usageOf(snap, persona.id);

  if (kind === "vote") {
    if (
      usage.votesToday >=
      voteCapPerPersona(config.content.maxVotesPerDay, snap.activePersonaCount)
    ) {
      return "persona_vote_cap";
    }
  } else if (kind !== "summary") {
    const cap = Math.min(
      persona.limits.maxContentActionsPerDay,
      config.personas.maxContentActionsPerPersonaPerDay,
    );
    if (usage.contentToday >= cap) return "persona_daily_cap";
  }

  if (kind === "thread" || kind === "reply") {
    const cooldownMinutes = Math.max(
      persona.limits.replyCooldownMinutes,
      config.personas.minimumReplyCooldownMinutes,
    );
    if (
      usage.lastContentAt &&
      snap.now.getTime() - usage.lastContentAt.getTime() < cooldownMinutes * 60_000
    ) {
      return "cooldown";
    }
  }
  return null;
}

/** The global daily maximum of a kind (summaries have their own). */
export function globalReason(
  snap: SchedulerSnapshot,
  config: AgoraConfig,
  kind: ActionKind,
): IneligibleReason | null {
  const max =
    kind === "summary" ? config.content.maxSummariesPerDay : dailyMaxFor(kind, config.content);
  return snap.usedToday[kind] >= max ? "global_daily_cap" : null;
}

/**
 * Length of the alternating chain A, B, A, B... that ends at `target`, counted
 * from the target upwards while the authors alternate between the target's
 * author (B) and `personaId` (A). With a limit of 4, the chain A -> B -> A -> B
 * (B newest) counts 4, so A may not reply; with a limit of 5, A may.
 */
export function pairChainLength(
  target: Pick<SnapshotComment, "authorPersonaId" | "parentCommentId">,
  personaId: string,
  lookup: (
    id: string,
  ) => Pick<SnapshotComment, "authorPersonaId" | "parentCommentId"> | undefined,
): number {
  const other = target.authorPersonaId;
  let expected = other;
  let count = 0;
  let current: Pick<SnapshotComment, "authorPersonaId" | "parentCommentId"> | undefined =
    target;
  while (current && current.authorPersonaId === expected) {
    count += 1;
    expected = expected === other ? personaId : other;
    current = current.parentCommentId ? lookup(current.parentCommentId) : undefined;
  }
  return count;
}

export type ReplyTarget =
  | { type: "thread"; thread: SnapshotThread }
  | { type: "comment"; thread: SnapshotThread; comment: SnapshotComment };

export function replyReason(
  snap: SchedulerSnapshot,
  config: AgoraConfig,
  persona: PersonaInfo,
  target: ReplyTarget,
): IneligibleReason | null {
  const { thread } = target;
  if (!persona.affinity.has(thread.communityId)) return "not_member";
  const targetId = target.type === "thread" ? thread.id : target.comment.id;
  if (snap.queuedReplyTargets.has(targetId)) return "reply_in_flight";
  const contributions = snap.threadContributions.get(`${persona.id}:${thread.id}`) ?? 0;
  if (contributions >= config.scheduler.maxThreadContributionsPerPersonaPerDay) {
    return "thread_contribution_cap";
  }
  if (target.type === "comment") {
    const { comment } = target;
    if (comment.authorPersonaId === persona.id) return "own_comment";
    if (comment.depth + 1 >= config.content.maxCommentDepth) return "depth_limit";
    if (
      pairChainLength(comment, persona.id, (id) => snap.commentsById.get(id)) >=
      config.personas.maxConsecutivePairReplies
    ) {
      return "pair_chain";
    }
    const last = snap.pairLast.get(`${persona.id}:${comment.authorPersonaId}`);
    if (
      last &&
      snap.now.getTime() - last.getTime() < config.scheduler.pairCooldownMinutes * 60_000
    ) {
      return "pair_cooldown";
    }
  }
  return null;
}

export function threadReason(
  snap: SchedulerSnapshot,
  persona: PersonaInfo,
  communityId: string,
): IneligibleReason | null {
  const affinity = persona.affinity.get(communityId);
  if (affinity === undefined) return "not_member";
  if (affinity < 2) return "low_affinity";
  if (snap.communities.get(communityId)?.isActive === false) return "community_inactive";
  return null;
}

export function revisionReason(
  snap: SchedulerSnapshot,
  persona: PersonaInfo,
  comment: SnapshotComment,
): IneligibleReason | null {
  if (comment.authorPersonaId !== persona.id) return "not_author";
  if (comment.revision >= MAX_REVISION_NUMBER) return "revision_limit";
  if (snap.queuedRevisionTargets.has(comment.id)) return "revision_in_flight";
  return null;
}

export function voteReason(
  snap: SchedulerSnapshot,
  persona: PersonaInfo,
  target: { id: string; authorPersonaId: string; communityId: string },
): IneligibleReason | null {
  if (target.authorPersonaId === persona.id) return "own_content";
  if (snap.votedTargets.has(`${persona.id}:${target.id}`)) return "already_voted";
  const affinity = persona.affinity.get(target.communityId);
  if (affinity === undefined) return "not_member";
  if (affinity < 2) return "low_affinity";
  return null;
}

export function summaryReason(
  snap: SchedulerSnapshot,
  thread: SnapshotThread,
): IneligibleReason | null {
  return snap.queuedSummaryThreads.has(thread.id) ? "summary_in_flight" : null;
}
