import type { AgoraConfig } from "@/lib/config/schema";
import {
  ProviderNotConfiguredError,
  type GateKind,
  type StructuredValidationProvider,
  type ValidationVerdict,
} from "@/lib/providers/types";
import {
  assessSerbian,
  isAcceptableLanguage,
  type LanguageAssessment,
} from "@/lib/serbian/detect";
import { findTopicalMarkers, type TopicalCheck } from "@/lib/serbian/topics";
import { findEncodingIssues } from "@/lib/serbian/script";

/**
 * The central publication gate. Every create and update of public prose runs
 * through runPublicationGate before any database mutation; the domain services
 * are the only callers, and nothing publishes on a non-pass outcome.
 *
 * Order matters for cost: shape, encoding, script, language, and topical
 * checks are free and run first. The structured validator (a paid call in
 * live mode) runs only when everything cheap has passed.
 */

export type GateOutcome = "pass" | "quarantine";

export interface GateInput {
  kind: GateKind;
  title?: string;
  body: string;
  /** Extra public prose validated for language and encoding only (e.g. a revision reason). */
  notes?: string[];
  context: {
    communitySlug: string;
    communityName: string;
    inheritsTopic: boolean;
    threadTitle?: string;
    parentExcerpt?: string;
  };
  evidence?: { id: string; title: string; summary: string }[];
  claimedEvidenceIds?: string[];
  /** Stable key so validator calls are reproducible and retries identical. */
  seed: string;
}

export interface GateReport {
  outcome: GateOutcome;
  codes: string[];
  /** Script the text will be stored under; null when it could not be determined. */
  script: "Latin" | "Cyrillic" | null;
  language: LanguageAssessment;
  topical: TopicalCheck;
  validator: ValidationVerdict | null;
  limits: { maxTitle: number | null; maxBody: number };
}

export interface GateDependencies {
  config: AgoraConfig;
  validator: StructuredValidationProvider;
}

const TITLE_KINDS = new Set<GateKind>(["thread", "revision_thread"]);
const TOPICAL_KINDS = new Set<GateKind>(["thread", "revision_thread", "summary"]);

function bodyLimit(kind: GateKind, config: AgoraConfig): number {
  switch (kind) {
    case "thread":
    case "revision_thread":
    case "summary":
      return config.content.maxThreadCharacters;
    case "comment":
    case "revision_comment":
      return config.content.maxCommentCharacters;
    case "persona_profile":
    case "community_description":
      return 2000;
    case "moderation_note":
      return 1000;
  }
}

export async function runPublicationGate(
  input: GateInput,
  deps: GateDependencies,
): Promise<GateReport> {
  const { config } = deps;
  const codes: string[] = [];
  const title = input.title?.trim() ?? "";
  const body = input.body.trim();
  const notes = (input.notes ?? [])
    .map((note) => note.trim())
    .filter((note) => note.length > 0);
  const needsTitle = TITLE_KINDS.has(input.kind);
  const maxBody = bodyLimit(input.kind, config);
  const maxTitle = needsTitle ? config.content.maxTitleCharacters : null;

  // 1. Shape and length.
  if (body.length === 0) codes.push("empty_body");
  if (body.length > maxBody) codes.push("body_too_long");
  if (needsTitle) {
    if (title.length === 0) codes.push("empty_title");
    else if (title.length < 8) codes.push("title_too_short");
    if (maxTitle !== null && title.length > maxTitle) codes.push("title_too_long");
  } else if (title.length > 0) {
    codes.push("unexpected_title");
  }

  // 2. Encoding.
  const allText = [title, body, ...notes].join("\n");
  for (const issue of findEncodingIssues(allText)) codes.push(issue);

  // 3. Script and language.
  const language = assessSerbian(`${title}\n${body}`);
  let script: "Latin" | "Cyrillic" | null = null;
  if (language.script.dominant === "Latin" || language.script.dominant === "Cyrillic") {
    script = language.script.dominant;
    if (!config.product.acceptedContentScripts.includes(script))
      codes.push("script_not_accepted");
  } else if (language.script.dominant === "Mixed") {
    codes.push("mixed_script");
  } else if (body.length > 0) {
    codes.push("no_letters");
  }
  if (!isAcceptableLanguage(language.outcome)) codes.push(`language_${language.outcome}`);
  for (const code of language.codes) {
    if (!codes.includes(code)) codes.push(code);
  }
  for (const note of notes) {
    const noteAssessment = assessSerbian(note);
    if (!isAcceptableLanguage(noteAssessment.outcome) && noteAssessment.tokens >= 3) {
      codes.push(`note_language_${noteAssessment.outcome}`);
    }
  }

  // 4. Topical connection for content that does not inherit it from a thread.
  const topical = findTopicalMarkers(`${title}\n${body}`);
  if (TOPICAL_KINDS.has(input.kind) && !input.context.inheritsTopic && !topical.hit) {
    codes.push("no_topical_marker");
  }

  // 5. Evidence references must come from the offered set.
  const offered = new Set((input.evidence ?? []).map((item) => item.id));
  const claimed = input.claimedEvidenceIds ?? [];
  if (claimed.some((id) => !offered.has(id))) codes.push("invented_citation");

  const limits = { maxTitle, maxBody };
  // Soft codes are recorded but do not block on their own.
  const blocking = codes.filter((code) => !SOFT_CODES.has(code));
  if (blocking.length > 0) {
    return { outcome: "quarantine", codes, script, language, topical, validator: null, limits };
  }

  // 6. Structured validation, bounded and only after the cheap checks pass.
  let validator: ValidationVerdict | null = null;
  try {
    validator = await deps.validator.validate({
      kind: input.kind,
      title: needsTitle ? title : undefined,
      body,
      context: input.context,
      heuristics: { language, topical },
      evidence: input.evidence ?? [],
      claimedEvidenceIds: claimed,
      seed: input.seed,
      maxOutputTokens: config.budget.validationMaxBilledOutputTokens,
    });
  } catch (error) {
    codes.push(
      error instanceof ProviderNotConfiguredError
        ? "validator_not_configured"
        : "validator_unavailable",
    );
    return { outcome: "quarantine", codes, script, language, topical, validator: null, limits };
  }

  if (validator.verdict !== "pass") {
    codes.push(validator.verdict === "reject" ? "validator_rejected" : "validator_review");
    for (const reason of validator.reasons) codes.push(reason);
    return { outcome: "quarantine", codes, script, language, topical, validator, limits };
  }

  return { outcome: "pass", codes, script, language, topical, validator, limits };
}

/** Recorded for transparency but not sufficient to block publication alone. */
const SOFT_CODES = new Set(["foreign_cyrillic_letters"]);
