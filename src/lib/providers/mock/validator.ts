import { isAcceptableLanguage } from "@/lib/serbian/detect";
import { normalizeForSearch } from "@/lib/serbian/normalize";
import {
  syntheticUsage,
  type StructuredValidationProvider,
  type ValidationRequest,
  type ValidationVerdict,
} from "../types";

/**
 * Deterministic validator for mock mode and tests. It applies the same
 * heuristics the gate already computed, checks claimed evidence against the
 * offered set, and screens for a short list of clearly abusive phrases. It is
 * not a language model and does not pretend to judge nuance.
 */

/** Test hook: any text containing this marker is rejected on moderation grounds. */
export const MODERATION_TEST_MARKER = "[[test:moderation]]";

/** Normalised phrases that are never acceptable regardless of context. */
const BLOCKED_PHRASES = [
  "ubicu te",
  "ubiti cu te",
  "treba ga ubiti",
  "treba ih ubiti",
  "treba je ubiti",
  "pobiti ih sve",
  "smrt svima",
  "zapalite im",
];

const TOPICAL_KINDS = new Set(["thread", "revision_thread", "summary"]);

export class MockValidationProvider implements StructuredValidationProvider {
  readonly name = "mock";
  readonly model = "mock-deterministic-v1";
  readonly configured = true;

  async validate(request: ValidationRequest): Promise<ValidationVerdict> {
    const reasons: string[] = [];
    const combined = `${request.title ?? ""}\n${request.body}`;

    const languageOk = isAcceptableLanguage(request.heuristics.language.outcome);
    if (!languageOk) reasons.push(`validator:language_${request.heuristics.language.outcome}`);

    const needsTopic = TOPICAL_KINDS.has(request.kind) && !request.context.inheritsTopic;
    const topicalOk = !needsTopic || request.heuristics.topical.hit;
    if (!topicalOk) reasons.push("validator:off_topic");

    const offered = new Set(request.evidence.map((item) => item.id));
    const invented = request.claimedEvidenceIds.filter((id) => !offered.has(id));
    const evidenceOk = invented.length === 0;
    if (!evidenceOk) reasons.push("validator:invented_citation");

    const normalized = normalizeForSearch(combined);
    const blocked =
      combined.toLowerCase().includes(MODERATION_TEST_MARKER) ||
      BLOCKED_PHRASES.some((phrase) => ` ${normalized} `.includes(` ${phrase} `));
    const moderationOk = !blocked;
    if (!moderationOk) reasons.push("validator:moderation");

    const verdict = reasons.length === 0 ? "pass" : "reject";
    const explanation =
      verdict === "pass"
        ? "Tekst zadovoljava jezičke, tematske i moderatorske provere (mock)."
        : `Tekst nije prošao provere: ${reasons.join(", ")} (mock).`;
    return {
      verdict,
      languageOk,
      topicalOk,
      evidenceOk,
      moderationOk,
      reasons,
      explanation,
      usage: syntheticUsage(request, explanation + reasons.join("")),
      provider: this.name,
      model: "mock-deterministic-v1",
    };
  }
}
