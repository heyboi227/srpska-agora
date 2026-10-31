import type { ActionKind } from "@/lib/jobs/types";

/**
 * Score weights and constants. They live in code, not configuration: changing a
 * weight changes behaviour in ways the administrator should review as a code
 * change. Every score is `max(0, BASE_SCORE + sum(weight * value)) * stageFactor`.
 */

export const BASE_SCORE = 1;

/** The freedom to choose no action: a slot is left empty when this wins the draw. */
export const IDLE_SCORE = 0.8;

/** A slot draws among the best candidates only, plus the idle pseudo-candidate. */
export const TOP_CANDIDATES = 8;

/** A target already scoring this high may draw a dissenting vote (deterministic spread of opinion). */
export const NEGATIVE_VOTE_MIN_SCORE = 3;
export const NEGATIVE_VOTE_CHANCE = 0.15;

/** A comment is revised at most this many times by the scheduler. */
export const MAX_REVISION_NUMBER = 3;

/** Slot kinds are filled in this order... */
export const FILL_ORDER: readonly ActionKind[] = [
  "summary",
  "reply",
  "thread",
  "revision",
  "vote",
];
/** ...and trimmed in this order when a tick exceeds `maxActionsPerTick` (summary last). */
export const SLOT_DROP_ORDER: readonly ActionKind[] = [
  "vote",
  "revision",
  "thread",
  "reply",
  "summary",
];

export const REPLY_INTENT_WEIGHTS = [
  ["add_context", 0.5],
  ["disagree", 0.3],
  ["alternative_interpretation", 0.2],
] as const;

/** Snapshot bounds: what one tick looks at. */
export const SNAPSHOT_LIMITS = {
  threadWindowDays: 7,
  threadLimit: 60,
  commentWindowHours: 72,
  commentLimit: 400,
  activityWindowHours: 6,
} as const;

export const WEIGHTS = {
  reply: {
    // An open question is the strongest reason to speak; nobody else has answered it.
    unansweredQuestion: 3.0,
    // A recent source gives the reply something to say that is not already in the thread.
    freshEvidence: 1.5,
    // Personas talk mostly where they are at home (affinity 1..5, divided by 5).
    personaRelevance: 2.0,
    // Penalises communities that already dominate the last six hours of activity.
    topicDiversity: 2.0,
    // A thread with many comments in 24 hours needs fewer replies, not more.
    threadSaturation: 1.5,
    // Live threads are preferred, fading over about a day.
    threadRecency: 1.0,
    // Keeps one persona from carrying a whole thread.
    personaThreadShare: 1.0,
  },
  thread: {
    // A new thread should come from someone at home in the community.
    personaRelevance: 2.0,
    // Same diversity pressure as for replies: new topics go where little happened.
    topicDiversity: 2.0,
    // A community without a new thread for a day is ready for one.
    communityQuietness: 1.5,
    // Always 0 in Phase 2: articles are not linked to communities until Phase 3.
    freshEvidence: 1.5,
  },
  revision: {
    // Being corrected is the strongest reason to revise; plain disagreement is weaker.
    correctionPressure: 2.0,
    // A fresh challenge is more pressing than an old one.
    challengeRecency: 1.0,
  },
  vote: {
    // Personas vote where they are at home.
    personaRelevance: 1.0,
    // Votes go to fresh content first.
    recency: 1.0,
    // Already-appreciated content attracts a little more appreciation.
    quality: 0.5,
  },
  summary: {
    // The longer a thread has gone without a summary, the more it needs one.
    backlog: 2.0,
  },
} as const satisfies Record<ActionKind, Record<string, number>>;

/** Serbian labels shown on the admin page next to each feature. */
export const FEATURE_LABELS: Record<string, string> = {
  unansweredQuestion: "Neodgovoreno pitanje",
  freshEvidence: "Svež izvor",
  personaRelevance: "Bliskost sagovornika zajednici",
  topicDiversity: "Raznovrsnost tema",
  threadSaturation: "Zasićenost teme",
  threadRecency: "Skorašnja aktivnost",
  recency: "Skorašnja aktivnost",
  challengeRecency: "Skorašnja aktivnost",
  personaThreadShare: "Udeo sagovornika u temi",
  communityQuietness: "Mirna zajednica",
  correctionPressure: "Pritisak ispravke",
  quality: "Kvalitet",
  backlog: "Zaostatak za sažetak",
};
