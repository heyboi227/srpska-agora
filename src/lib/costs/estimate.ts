import type { Usage } from "@/lib/providers/types";
import type { ModelPrice } from "./prices";

/**
 * Conservative for Serbian (Cyrillic included). The flat 2,000 covers what the
 * payload does not show: the English instructions plus the JSON schema run to
 * about 1,000 to 1,500 tokens.
 */
export function estimateInputTokens(payload: unknown): number {
  return Math.ceil((JSON.stringify(payload) ?? "").length / 2) + 2000;
}

/** max_output_tokens caps reasoning and visible output together, so this is a true upper bound. */
export function estimateUpperBoundMicros(
  price: ModelPrice,
  estimatedInputTokens: number,
  maxOutputTokens: number,
): number {
  return Math.ceil(
    estimatedInputTokens * price.inputPerMillionUsd +
      maxOutputTokens * price.outputPerMillionUsd +
      (price.perCallUsd ?? 0) * 1e6,
  );
}

export function actualCostMicros(price: ModelPrice, usage: Usage): number {
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  return Math.ceil(
    (usage.inputTokens - cached) * price.inputPerMillionUsd +
      cached * price.cachedInputPerMillionUsd +
      usage.outputTokens * price.outputPerMillionUsd +
      (price.perCallUsd ?? 0) * 1e6,
  );
}
