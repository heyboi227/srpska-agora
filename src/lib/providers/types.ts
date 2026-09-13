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
  estimatedCostUsd: number;
}

export const ZERO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  estimatedCostUsd: 0,
};

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
}

export interface GenerationResult {
  title?: string;
  body: string;
  script: ContentScript;
  /** Fact ids the text relies on; the gate rejects ids that were not offered. */
  evidenceIds: string[];
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

export interface TextGenerationProvider {
  readonly name: string;
  readonly configured: boolean;
  generate(request: GenerationRequest): Promise<GenerationResult>;
}

export interface StructuredValidationProvider {
  readonly name: string;
  readonly configured: boolean;
  validate(request: ValidationRequest): Promise<ValidationVerdict>;
}

export interface NewsSearchProvider {
  readonly name: string;
  readonly configured: boolean;
  search(request: SearchRequest): Promise<SearchResult>;
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
