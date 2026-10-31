/**
 * Dated price table. USD per 1M tokens is numerically the same as micro-USD
 * per token, so rates multiply token counts straight into micro-USD.
 */
export interface ModelPrice {
  provider: string;
  model: string;
  inputPerMillionUsd: number;
  cachedInputPerMillionUsd: number;
  outputPerMillionUsd: number;
  /** Flat fee per call (for example a paid search), in USD. */
  perCallUsd?: number;
  verifiedAt: string;
  source: string;
}

export type PriceTable = readonly ModelPrice[];

const LUNA_SOURCE = "https://developers.openai.com/api/docs/models/gpt-5.6-luna";

const LUNA: ModelPrice = {
  provider: "openai",
  model: "gpt-5.6-luna",
  inputPerMillionUsd: 0.2,
  cachedInputPerMillionUsd: 0.02,
  outputPerMillionUsd: 1.2,
  verifiedAt: "2026-10-31",
  source: LUNA_SOURCE,
};

export const PRICE_TABLE: PriceTable = [
  LUNA,
  {
    provider: "mock",
    model: "*",
    inputPerMillionUsd: 0,
    cachedInputPerMillionUsd: 0,
    outputPerMillionUsd: 0,
    verifiedAt: "2026-10-31",
    source: "mock providers make no external call",
  },
];

/** The 48-hour simulation prices the mock at Luna rates so budget stages move. */
export const SIMULATION_PRICE_TABLE: PriceTable = [
  LUNA,
  {
    provider: "mock",
    model: "*",
    inputPerMillionUsd: LUNA.inputPerMillionUsd,
    cachedInputPerMillionUsd: LUNA.cachedInputPerMillionUsd,
    outputPerMillionUsd: LUNA.outputPerMillionUsd,
    verifiedAt: "2026-10-31",
    source: LUNA_SOURCE,
  },
];

/** Exact provider and model first, then the provider's "*" entry, else null. */
export function findPrice(
  table: PriceTable,
  provider: string,
  model: string,
): ModelPrice | null {
  return (
    table.find((p) => p.provider === provider && p.model === model) ??
    table.find((p) => p.provider === provider && p.model === "*") ??
    null
  );
}
