import { z } from "zod";

/**
 * Strict JSON schemas sent to the model (every property required, no extras,
 * optional values nullable) and the zod mirrors that parse what comes back.
 */

export const VALIDATOR_REASONS = [
  "validator:language",
  "validator:off_topic",
  "validator:evidence",
  "validator:moderation",
  "validator:impersonation",
  "validator:hostility",
  "validator:privacy",
  "validator:low_value",
] as const;

export const generationJsonSchema = {
  type: "object",
  properties: {
    title: { type: ["string", "null"] },
    body: { type: "string" },
    script: { type: "string", enum: ["Latin", "Cyrillic"] },
    evidenceIds: { type: "array", items: { type: "string" } },
    memoryNote: { type: ["string", "null"] },
  },
  required: ["title", "body", "script", "evidenceIds", "memoryNote"],
  additionalProperties: false,
} as const;

export const validationJsonSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "reject", "review"] },
    languageOk: { type: "boolean" },
    topicalOk: { type: "boolean" },
    evidenceOk: { type: "boolean" },
    moderationOk: { type: "boolean" },
    reasons: { type: "array", items: { type: "string", enum: [...VALIDATOR_REASONS] } },
    explanation: { type: "string" },
  },
  required: [
    "verdict",
    "languageOk",
    "topicalOk",
    "evidenceOk",
    "moderationOk",
    "reasons",
    "explanation",
  ],
  additionalProperties: false,
} as const;

export const generationOutputSchema = z.object({
  title: z.string().nullable(),
  body: z.string(),
  script: z.enum(["Latin", "Cyrillic"]),
  evidenceIds: z.array(z.string()),
  memoryNote: z.string().nullable(),
});

export const validationOutputSchema = z.object({
  verdict: z.enum(["pass", "reject", "review"]),
  languageOk: z.boolean(),
  topicalOk: z.boolean(),
  evidenceOk: z.boolean(),
  moderationOk: z.boolean(),
  reasons: z.array(z.enum(VALIDATOR_REASONS)),
  explanation: z.string(),
});

export type GenerationOutput = z.infer<typeof generationOutputSchema>;
export type ValidationOutput = z.infer<typeof validationOutputSchema>;
