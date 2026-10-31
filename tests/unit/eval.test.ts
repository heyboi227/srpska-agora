import { describe, expect, it } from "vitest";
import { VALIDATION_CORPUS } from "@/fixtures/validation-corpus";
import { dialectAdherence, detectDialect, expectedDialect } from "@/lib/eval/dialect";
import {
  evaluateBar,
  summarizeCorpus,
  summarizeEffort,
  type CallRecord,
  type CorpusResult,
  type EvalSample,
} from "@/lib/eval/summary";

describe("detectDialect", () => {
  it("reads Ekavian and Ijekavian Latin words", () => {
    expect(detectDialect("Lepo vreme za šetnju pored reke.").reading).toBe("ekavian");
    expect(detectDialect("Lijepo vrijeme za šetnju pored rijeke.").reading).toBe("ijekavian");
  });

  it("reads Cyrillic through transliteration", () => {
    expect(detectDialect("Лепо време за децу и млеко.").ekavian).toBe(3);
    expect(detectDialect("Лијепо вријеме и мlијеко.".replace("мl", "мл")).reading).toBe(
      "ijekavian",
    );
  });

  it("reports mixed text", () => {
    const d = detectDialect("Lepo vreme, ali mlijeko je skupo.");
    expect(d).toMatchObject({ ekavian: 2, ijekavian: 1, reading: "mixed" });
  });

  it("returns unknown when no lexicon word occurs", () => {
    expect(detectDialect("Danas je ponedeljak.").reading).toBe("unknown");
    expect(detectDialect("").reading).toBe("unknown");
  });

  it("does not match inside longer words", () => {
    expect(detectDialect("detalji o svetlosti").reading).toBe("unknown");
  });
});

describe("expectedDialect and adherence", () => {
  it("reads the persona notes", () => {
    expect(expectedDialect("Ekavica. Kućni rečnik.")).toBe("ekavian");
    expect(expectedDialect("Ijekavica, hercegovački izgovor.")).toBe("ijekavian");
    expect(expectedDialect("Neformalno.")).toBeNull();
  });

  it("counts only recognised words", () => {
    expect(dialectAdherence("ekavian", detectDialect("Lepo vreme"))).toBe("match");
    expect(dialectAdherence("ekavian", detectDialect("Lijepo vrijeme"))).toBe("mismatch");
    expect(dialectAdherence("ekavian", detectDialect("Mixed lepo vrijeme"))).toBe("mismatch");
    expect(dialectAdherence("ekavian", detectDialect("Dobar dan"))).toBe("not_assessable");
    expect(dialectAdherence(null, detectDialect("Lepo vreme"))).toBe("not_assessable");
  });
});

const usage = (input: number, output: number, reasoning = 0) => ({
  inputTokens: input,
  cachedInputTokens: 0,
  outputTokens: output,
  reasoningTokens: reasoning,
  estimatedCostUsd: 0,
});

function call(over: Partial<CallRecord> = {}): CallRecord {
  return {
    purpose: "generation",
    usage: usage(100, 50, 10),
    costUsd: 0.01,
    incomplete: false,
    ...over,
  };
}

function sample(over: Partial<EvalSample> = {}): EvalSample {
  return {
    persona: "p",
    purpose: "thread",
    effort: "none",
    body: "x",
    expectedScript: "Latin",
    detectedScript: "Latin",
    scriptOk: true,
    firstCodes: [],
    firstPass: true,
    repaired: false,
    finalCodes: [],
    finalPass: true,
    verdictReasons: [],
    verdict: "pass",
    dialect: "match",
    incomplete: false,
    calls: [call(), call({ purpose: "validation" })],
    ...over,
  };
}

describe("summarizeEffort", () => {
  it("computes rates, tokens and costs for one effort", () => {
    const samples = [
      sample(),
      sample({
        purpose: "reply",
        firstPass: false,
        repaired: true,
        finalPass: true,
        dialect: "mismatch",
      }),
      sample({
        firstPass: false,
        finalPass: false,
        scriptOk: false,
        verdict: undefined,
        calls: [call({ incomplete: true, error: "x" })],
      }),
      sample({ effort: "low" }),
    ];
    const s = summarizeEffort("none", samples);
    expect(s.samples).toBe(3);
    expect(s.firstPassRate).toBeCloseTo(1 / 3);
    expect(s.afterRepairRate).toBeCloseTo(2 / 3);
    expect(s.scriptRate).toBeCloseTo(2 / 3);
    expect(s.dialectMatch).toBe(2);
    expect(s.dialectAssessable).toBe(3);
    expect(s.incompleteCount).toBe(1);
    expect(s.verdicts).toEqual({ pass: 2 });
    expect(s.callCount).toBe(5);
    expect(s.totalCostUsd).toBeCloseTo(0.05);
    expect(s.averageCostPerCallUsd).toBeCloseTo(0.01);
    expect(s.tokensByPurpose.thread.calls).toBe(2);
    expect(s.tokensByPurpose.thread.input).toBe(100);
    expect(s.tokensByPurpose.reply.reasoning).toBe(10);
  });

  it("counts a failed generation against every rate", () => {
    const s = summarizeEffort("none", [sample(), sample({ error: "boom", calls: [call()] })]);
    expect(s.failedGenerations).toBe(1);
    expect(s.firstPassRate).toBe(0.5);
    expect(s.scriptRate).toBe(0.5);
  });

  it("is safe with no samples", () => {
    const s = summarizeEffort("none", []);
    expect(s.samples).toBe(0);
    expect(s.firstPassRate).toBe(0);
    expect(s.averageCostPerCallUsd).toBe(0);
  });
});

describe("summarizeCorpus", () => {
  const r = (over: Partial<CorpusResult>): CorpusResult => ({
    id: "a",
    category: "serbian",
    expected: "pass",
    verdict: "pass",
    reasons: [],
    costUsd: 0.001,
    ...over,
  });

  it("finds agreement, false passes and false rejects", () => {
    const c = summarizeCorpus([
      r({ id: "ok" }),
      r({ id: "fr", verdict: "reject" }),
      r({ id: "fp", category: "violation", expected: "non_pass", verdict: "pass" }),
      r({ id: "ns", category: "non_serbian", expected: "non_pass", verdict: "pass" }),
      r({ id: "good", category: "non_serbian", expected: "non_pass", verdict: "review" }),
    ]);
    expect(c.agreement).toBeCloseTo(2 / 5);
    expect(c.falsePasses).toEqual(["fp", "ns"]);
    expect(c.falseRejects).toEqual(["fr"]);
    expect(c.nonSerbianPasses).toEqual(["ns"]);
    expect(c.totalCostUsd).toBeCloseTo(0.005);
  });
});

describe("evaluateBar", () => {
  const corpusOk = summarizeCorpus([]);

  it("passes when every threshold is met", () => {
    const s = summarizeEffort(
      "none",
      Array.from({ length: 100 }, () => sample()),
    );
    const lines = evaluateBar(s, corpusOk);
    expect(lines).toHaveLength(4);
    expect(lines.every((l) => l.pass)).toBe(true);
  });

  it("fails each threshold independently", () => {
    const many = (n: number, over: Partial<EvalSample>) =>
      Array.from({ length: n }, () => sample(over));
    // 89 % first pass, 96 % after repair, one wrong script.
    const s = summarizeEffort("none", [
      ...many(89, {}),
      ...many(7, { firstPass: false, repaired: true, finalPass: true }),
      ...many(3, { firstPass: false, finalPass: false }),
      ...many(1, { scriptOk: false, firstPass: false, finalPass: false }),
    ]);
    const lines = evaluateBar(
      s,
      summarizeCorpus([
        {
          id: "x",
          category: "non_serbian",
          expected: "non_pass",
          verdict: "pass",
          reasons: [],
          costUsd: 0,
        },
      ]),
    );
    expect(lines.map((l) => l.pass)).toEqual([false, false, false, false]);
  });

  it("omits the corpus line when no corpus ran and never passes an empty run", () => {
    const lines = evaluateBar(summarizeEffort("none", []), null);
    expect(lines).toHaveLength(3);
    expect(lines.some((l) => l.pass)).toBe(false);
  });
});

describe("validation corpus", () => {
  it("has the requested composition and unique ids", () => {
    const count = (c: string) => VALIDATION_CORPUS.filter((s) => s.category === c).length;
    expect(VALIDATION_CORPUS).toHaveLength(30);
    expect([
      count("serbian"),
      count("non_serbian"),
      count("violation"),
      count("off_topic"),
    ]).toEqual([12, 6, 6, 6]);
    expect(new Set(VALIDATION_CORPUS.map((s) => s.id)).size).toBe(30);
    expect(
      VALIDATION_CORPUS.filter((s) => s.category === "serbian").every(
        (s) => s.expected === "pass",
      ),
    ).toBe(true);
  });
});
