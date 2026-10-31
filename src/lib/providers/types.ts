import type { LanguageAssessment } from "@/lib/serbian/detect";
import type { TopicalCheck } from "@/lib/serbian/topics";

/**
 * Provider interfaces. Three separate capabilities, because they are priced,
 * bounded, and mocked differently. The server never trusts a provider result:
 * generation output goes through the publication gate, and validator verdicts
 * only ever narrow what may be published.
 */

export type ContentScript = "Latin" | "Cyrillic";

export type Intent =
  | "introduce_topic"
  | "ask_question"
  | "answer_question"
  | "add_context"
  | "disagree"
  | "alternative_interpretation"
  | "correct_earlier"
  | "summarize";

export const INTENTS: readonly Intent[] = [
  "introduce_topic",
  "ask_question",
  "answer_question",
  "add_context",
  "disagree",
  "alternative_interpretation",
  "correct_earlier",
  "summarize",
];

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Reasoning tokens are billed as output where the provider reports them. */
  reasoningTokens: number;
  /** Input tokens served from the provider's prompt cache (a subset of inputTokens). */
  cachedInputTokens: number;
  estimatedCostUsd: number;
}

export const ZERO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
  estimatedCostUsd: 0,
};

/** Deterministic synthetic usage for mocks: about three characters per token, no cost. */
export function syntheticUsage(request: unknown, outputText: string): Usage {
  return {
    inputTokens: Math.ceil(JSON.stringify(request).length / 3),
    outputTokens: Math.ceil(outputText.length / 3),
    reasoningTokens: 0,
    cachedInputTokens: 0,
    estimatedCostUsd: 0,
  };
}

export interface PersonaBrief {
  id: string;
  slug: string;
  displayName: string;
  style: string;
  scriptPreference: ContentScript;
  vocabularyNotes: string;
  interests: string[];
}

export interface FactItem {
  /** Article id; the server verifies every claimed id against the offered set. */
  id: string;
  publisher: string;
  title: string;
  summary: string;
  publishedAt: string;
}

export interface ConversationTurn {
  author: string;
  body: string;
}

export type GenerationPurpose =
  "thread" | "reply" | "revision" | "summary" | "profile" | "community_description";

export interface GenerationRequest {
  purpose: GenerationPurpose;
  persona: PersonaBrief;
  intent: Intent;
  context: {
    community: { slug: string; name: string; description: string };
    topicHint?: string;
    threadTitle?: string;
    /** The thread's opening post (published text only, truncated), for replies and summaries. */
    threadBody?: string;
    threadSummary?: string;
    parentChain?: ConversationTurn[];
    recentComments?: ConversationTurn[];
    facts?: FactItem[];
    memory?: string[];
    /** For revisions: the current text and the reason to revise. */
    currentBody?: string;
    revisionReason?: string;
  };
  /** Stable key (the action key) so a mock is reproducible and a retry is identical. */
  seed: string;
  maxOutputTokens: number;
  /** Length limit for the body, so a live model can be told. */
  maxBodyCharacters: number;
  /** Feedback for the one paid repair attempt: the previous draft and the gate codes it failed. */
  repair?: { previousTitle?: string; previousBody: string; codes: string[] };
}

export interface GenerationResult {
  title?: string;
  body: string;
  script: ContentScript;
  /** Fact ids the text relies on; the gate rejects ids that were not offered. */
  evidenceIds: string[];
  /** Private note (at most 200 characters) the persona keeps as memory; never public. */
  memoryNote?: string;
  usage: Usage;
  provider: string;
  model: string;
}

export type GateKind =
  | "thread"
  | "comment"
  | "revision_thread"
  | "revision_comment"
  | "persona_profile"
  | "community_description"
  | "moderation_note"
  | "summary";

export interface ValidationRequest {
  kind: GateKind;
  title?: string;
  body: string;
  context: {
    communitySlug: string;
    communityName: string;
    /** Replies inherit topical relevance from their thread. */
    inheritsTopic: boolean;
    threadTitle?: string;
    parentExcerpt?: string;
  };
  heuristics: {
    language: LanguageAssessment;
    topical: TopicalCheck;
  };
  evidence: Pick<FactItem, "id" | "title" | "summary">[];
  claimedEvidenceIds: string[];
  seed: string;
  maxOutputTokens: number;
}

export type Verdict = "pass" | "reject" | "review";

export interface ValidationVerdict {
  verdict: Verdict;
  languageOk: boolean;
  topicalOk: boolean;
  evidenceOk: boolean;
  moderationOk: boolean;
  /** Concise decision codes, e.g. "validator:off_topic". */
  reasons: string[];
  /** Serbian, one or two sentences, suitable for the administrator queue. */
  explanation: string;
  usage: Usage;
  provider: string;
  model: string;
}

export interface SearchRequest {
  query: string;
  maxResults: number;
  seed: string;
}

export interface SearchResultItem {
  url: string;
  title: string;
  snippet: string;
  publisher?: string;
  publishedAt?: string;
}

export interface SearchResult {
  items: SearchResultItem[];
  /** Number of billable search calls this request consumed. */
  billableCalls: number;
  usage: Usage;
  provider: string;
}

// Every provider names its model up front so the cost gateway can price a call
// before dispatching it. The optional signal lets the gateway enforce a timeout.

export interface TextGenerationProvider {
  readonly name: string;
  readonly model: string;
  readonly configured: boolean;
  generate(request: GenerationRequest, signal?: AbortSignal): Promise<GenerationResult>;
}

export interface StructuredValidationProvider {
  readonly name: string;
  readonly model: string;
  readonly configured: boolean;
  validate(request: ValidationRequest, signal?: AbortSignal): Promise<ValidationVerdict>;
}

export interface NewsSearchProvider {
  readonly name: string;
  readonly model: string;
  readonly configured: boolean;
  search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResult>;
}

export interface ProviderSet {
  mode: "mock" | "live";
  generation: TextGenerationProvider;
  validation: StructuredValidationProvider;
  search: NewsSearchProvider;
}

/** Raised by a live adapter that has no credentials. Never falls back to mock output. */
export class ProviderNotConfiguredError extends Error {
  constructor(public readonly capability: keyof Omit<ProviderSet, "mode">) {
    super(`Provider for ${capability} is not configured.`);
    this.name = "ProviderNotConfiguredError";
  }
}

/**
 * How a failed provider call was billed. "not_billed": the provider refused it
 * before doing work (a 4xx, a refused connection). "billed": it did work and
 * reported usage (an incomplete or refused response). "ambiguous": the outcome
 * is unknown (a timeout, a dropped connection), so the cost gateway counts the
 * full estimate until a reconciliation settles it.
 */
export type ProviderBilling = "not_billed" | "billed" | "ambiguous";

/** Raised by adapters so the cost gateway and the job runner know what a failure cost and whether to retry. */
export class ProviderCallError extends Error {
  constructor(
    message: string,
    public readonly billing: ProviderBilling,
    public readonly retryable: boolean,
    public readonly details: { status?: number; code?: string; usage?: Usage } = {},
  ) {
    super(message);
    this.name = "ProviderCallError";
  }
}
