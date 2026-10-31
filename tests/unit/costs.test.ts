import { describe, expect, it } from "vitest";
import { classifyBilling, safeErrorText } from "@/lib/costs/gateway";
import {
  actualCostMicros,
  estimateInputTokens,
  estimateUpperBoundMicros,
} from "@/lib/costs/estimate";
import {
  findPrice,
  PRICE_TABLE,
  SIMULATION_PRICE_TABLE,
  type ModelPrice,
} from "@/lib/costs/prices";
import {
  budgetStageFor,
  stageFactor,
  STAGE_EXPLANATIONS,
  STAGE_LABELS,
} from "@/lib/costs/stages";
import {
  ProviderCallError,
  ProviderNotConfiguredError,
  ZERO_USAGE,
} from "@/lib/providers/types";

const luna = findPrice(PRICE_TABLE, "openai", "gpt-5.6-luna")!;
const usage = (over: Partial<typeof ZERO_USAGE>) => ({ ...ZERO_USAGE, ...over });

describe("price table", () => {
  it("finds exact, then wildcard, else null", () => {
    expect(luna.inputPerMillionUsd).toBe(0.2);
    expect(findPrice(PRICE_TABLE, "mock", "anything")?.outputPerMillionUsd).toBe(0);
    expect(findPrice(PRICE_TABLE, "openai", "other-model")).toBeNull();
    expect(findPrice(PRICE_TABLE, "nobody", "x")).toBeNull();
  });

  it("prices the mock at Luna rates in the simulation table", () => {
    expect(findPrice(SIMULATION_PRICE_TABLE, "mock", "mock-1")?.outputPerMillionUsd).toBe(1.2);
  });
});

describe("estimates", () => {
  it("estimates input tokens from the serialized payload", () => {
    expect(estimateInputTokens("a".repeat(98))).toBe(Math.ceil(100 / 2) + 2000);
  });

  it("matches the COST_MODEL example: 2,000 in + 500 out = 1,000 micro-USD", () => {
    expect(actualCostMicros(luna, usage({ inputTokens: 2000, outputTokens: 500 }))).toBe(1000);
  });

  it("prices cached input at the cached rate", () => {
    expect(actualCostMicros(luna, usage({ inputTokens: 2000, cachedInputTokens: 1000 }))).toBe(
      Math.ceil(1000 * 0.2 + 1000 * 0.02),
    );
  });

  it("adds a per-call fee", () => {
    const search: ModelPrice = { ...luna, perCallUsd: 0.01 };
    expect(actualCostMicros(search, ZERO_USAGE)).toBe(10_000);
    expect(estimateUpperBoundMicros(search, 0, 0)).toBe(10_000);
  });

  it("bounds the upper estimate by max output tokens", () => {
    expect(estimateUpperBoundMicros(luna, 1000, 800)).toBe(Math.ceil(1000 * 0.2 + 800 * 1.2));
  });

  it("costs nothing for the mock", () => {
    const mock = findPrice(PRICE_TABLE, "mock", "m")!;
    expect(actualCostMicros(mock, usage({ inputTokens: 9999, outputTokens: 9999 }))).toBe(0);
    expect(estimateUpperBoundMicros(mock, 9999, 9999)).toBe(0);
  });
});

describe("budget stages", () => {
  const stage = (remaining: number, pause = false, daily = 100) =>
    budgetStageFor({
      remainingMicros: remaining,
      dailyLimitMicros: daily,
      pausePaidActions: pause,
    });

  it("follows the thresholds", () => {
    expect(stage(100)).toBe("normal");
    expect(stage(41)).toBe("normal");
    expect(stage(40)).toBe("reduced");
    expect(stage(21)).toBe("reduced");
    expect(stage(20)).toBe("minimal");
    expect(stage(6)).toBe("minimal");
    expect(stage(5)).toBe("paused");
    expect(stage(0)).toBe("paused");
  });

  it("pauses once one more action cannot fit, whatever the percentage says", () => {
    const withReserve = (remaining: number, reserve: number) =>
      budgetStageFor({
        remainingMicros: remaining,
        dailyLimitMicros: 100,
        pausePaidActions: false,
        actionReserveMicros: reserve,
      });
    // 15 % remains, so "minimal" by share, but a reserve of 15 or more pauses.
    expect(withReserve(15, 0)).toBe("minimal");
    expect(withReserve(15, 14)).toBe("minimal");
    expect(withReserve(15, 15)).toBe("paused");
    expect(withReserve(15, 30)).toBe("paused");
    // The 5 % threshold still applies when the reserve is smaller.
    expect(withReserve(5, 2)).toBe("paused");
    // The other thresholds stay.
    expect(withReserve(40, 2)).toBe("reduced");
    expect(withReserve(100, 2)).toBe("normal");
  });

  it("pauses on the flag or a zero daily limit", () => {
    expect(stage(100, true)).toBe("paused");
    expect(stage(0, false, 0)).toBe("paused");
  });

  const flags = { affinity: 5, freshEvidence: false, answersOpenQuestion: false };
  it("applies the factor table", () => {
    expect(stageFactor("normal", "thread", flags)).toBe(1);
    expect(stageFactor("reduced", "thread", flags)).toBe(0.5);
    expect(stageFactor("reduced", "thread", { ...flags, affinity: 3 })).toBe(0);
    expect(stageFactor("reduced", "reply", flags)).toBe(0.6);
    expect(stageFactor("reduced", "revision", flags)).toBe(1);
    expect(stageFactor("minimal", "thread", flags)).toBe(0);
    expect(stageFactor("minimal", "thread", { ...flags, freshEvidence: true })).toBe(0.3);
    expect(stageFactor("minimal", "reply", flags)).toBe(0);
    expect(stageFactor("minimal", "reply", { ...flags, answersOpenQuestion: true })).toBe(1);
    expect(stageFactor("minimal", "reply", { ...flags, freshEvidence: true })).toBe(1);
    expect(stageFactor("minimal", "revision", flags)).toBe(0);
    expect(stageFactor("minimal", "summary", flags)).toBe(1);
    expect(stageFactor("paused", "thread", flags)).toBe(0);
    expect(stageFactor("paused", "summary", flags)).toBe(0);
  });

  it("lets votes continue at every stage", () => {
    for (const s of ["normal", "reduced", "minimal", "paused"] as const) {
      expect(stageFactor(s, "vote", flags)).toBe(1);
      expect(STAGE_LABELS[s].length).toBeGreaterThan(0);
      expect(STAGE_EXPLANATIONS[s].length).toBeGreaterThan(0);
    }
  });
});

describe("billing classification", () => {
  it("maps errors to billing states", () => {
    expect(classifyBilling(new ProviderCallError("x", "not_billed", true))).toBe("not_billed");
    expect(classifyBilling(new ProviderCallError("x", "billed", false))).toBe("billed");
    expect(classifyBilling(new ProviderNotConfiguredError("generation"))).toBe("not_billed");
    expect(classifyBilling(new Error("socket hang up"))).toBe("ambiguous");
    expect(classifyBilling(new DOMException("aborted", "AbortError"))).toBe("ambiguous");
  });

  it("redacts keys and truncates error text", () => {
    const text = safeErrorText(new Error(`bad key sk-abcdefgh12345678 ${"x".repeat(900)}`));
    expect(text).not.toContain("sk-abcdefgh");
    expect(text.length).toBeLessThanOrEqual(500);
  });
});
