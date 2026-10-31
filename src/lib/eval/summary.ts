import type { ContentScript, Usage } from "@/lib/providers/types";
import type { DialectAdherence } from "./dialect";

/** Pure summary maths and the adoption bar for the Serbian evaluation. */

export type EvalPurpose = "thread" | "reply";

export interface CallRecord {
  purpose: "generation" | "repair" | "validation";
  usage: Usage;
  costUsd: number;
  incomplete: boolean;
  error?: string;
}

export interface EvalSample {
  persona: string;
  purpose: EvalPurpose;
  effort: string;
  title?: string;
  body: string;
  expectedScript: ContentScript;
  detectedScript: ContentScript | null;
  scriptOk: boolean;
  /** Codes from the free checks (and the evidence rule) before any repair. */
  firstCodes: string[];
  firstPass: boolean;
  repaired: boolean;
  finalCodes: string[];
  finalPass: boolean;
  verdict?: string;
  verdictReasons: string[];
  dialect: DialectAdherence;
  incomplete: boolean;
  calls: CallRecord[];
  /** Set when generation failed and no draft exists. */
  error?: string;
}

export interface CorpusResult {
  id: string;
  category: "serbian" | "non_serbian" | "violation" | "off_topic";
  expected: "pass" | "non_pass";
  verdict: string;
  reasons: string[];
  costUsd: number;
}

export const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

export const rate = (hits: number, total: number): number => (total === 0 ? 0 : hits / total);

export interface TokenAverages {
  calls: number;
  input: number;
  cached: number;
  output: number;
  reasoning: number;
}

export interface EffortSummary {
  effort: string;
  samples: number;
  /** Samples with no draft because generation itself failed. */
  failedGenerations: number;
  firstPassRate: number;
  afterRepairRate: number;
  scriptRate: number;
  dialectMatch: number;
  dialectAssessable: number;
  incompleteCount: number;
  verdicts: Record<string, number>;
  tokensByPurpose: Record<EvalPurpose, TokenAverages>;
  totalCostUsd: number;
  averageCostPerCallUsd: number;
  callCount: number;
}

function averages(calls: CallRecord[]): TokenAverages {
  return {
    calls: calls.length,
    input: mean(calls.map((c) => c.usage.inputTokens)),
    cached: mean(calls.map((c) => c.usage.cachedInputTokens)),
    output: mean(calls.map((c) => c.usage.outputTokens)),
    reasoning: mean(calls.map((c) => c.usage.reasoningTokens)),
  };
}

export function summarizeEffort(effort: string, all: EvalSample[]): EffortSummary {
  const samples = all.filter((s) => s.effort === effort);
  const drafts = samples.filter((s) => !s.error);
  const calls = samples.flatMap((s) => s.calls);
  const assessable = drafts.filter((s) => s.dialect !== "not_assessable");
  const verdicts: Record<string, number> = {};
  for (const s of drafts) {
    if (s.verdict) verdicts[s.verdict] = (verdicts[s.verdict] ?? 0) + 1;
  }
  const generation = (purpose: EvalPurpose) =>
    averages(
      samples
        .filter((s) => s.purpose === purpose)
        .flatMap((s) => s.calls.filter((c) => c.purpose !== "validation")),
    );
  const totalCostUsd = calls.reduce((sum, c) => sum + c.costUsd, 0);
  return {
    effort,
    samples: samples.length,
    failedGenerations: samples.length - drafts.length,
    // A failed generation counts against every rate: nothing was produced.
    firstPassRate: rate(drafts.filter((s) => s.firstPass).length, samples.length),
    afterRepairRate: rate(drafts.filter((s) => s.finalPass).length, samples.length),
    scriptRate: rate(drafts.filter((s) => s.scriptOk).length, samples.length),
    dialectMatch: assessable.filter((s) => s.dialect === "match").length,
    dialectAssessable: assessable.length,
    incompleteCount: calls.filter((c) => c.incomplete).length,
    verdicts,
    tokensByPurpose: { thread: generation("thread"), reply: generation("reply") },
    totalCostUsd,
    averageCostPerCallUsd: rate(totalCostUsd, calls.length),
    callCount: calls.length,
  };
}

export interface CorpusSummary {
  total: number;
  agreement: number;
  falsePasses: string[];
  falseRejects: string[];
  /** Non-Serbian samples the validator let through. */
  nonSerbianPasses: string[];
  totalCostUsd: number;
}

export function summarizeCorpus(results: CorpusResult[]): CorpusSummary {
  const agrees = (r: CorpusResult) => (r.expected === "pass") === (r.verdict === "pass");
  return {
    total: results.length,
    agreement: rate(results.filter(agrees).length, results.length),
    falsePasses: results
      .filter((r) => r.expected === "non_pass" && r.verdict === "pass")
      .map((r) => r.id),
    falseRejects: results
      .filter((r) => r.expected === "pass" && r.verdict !== "pass")
      .map((r) => r.id),
    nonSerbianPasses: results
      .filter((r) => r.category === "non_serbian" && r.verdict === "pass")
      .map((r) => r.id),
    totalCostUsd: results.reduce((sum, r) => sum + r.costUsd, 0),
  };
}

export interface BarLine {
  label: string;
  pass: boolean;
}

export const BAR = { firstPass: 0.9, afterRepair: 0.97 } as const;

/** The adoption bar for one effort; the corpus line is shared by all efforts. */
export function evaluateBar(summary: EffortSummary, corpus: CorpusSummary | null): BarLine[] {
  const pct = (v: number) => `${(v * 100).toFixed(1)} %`;
  const lines: BarLine[] = [
    {
      label: `correct script every time (${pct(summary.scriptRate)})`,
      pass: summary.samples > 0 && summary.scriptRate === 1,
    },
    {
      label: `at least 90 % pass the free checks first time (${pct(summary.firstPassRate)})`,
      pass: summary.samples > 0 && summary.firstPassRate >= BAR.firstPass,
    },
    {
      label: `at least 97 % pass after one repair (${pct(summary.afterRepairRate)})`,
      pass: summary.samples > 0 && summary.afterRepairRate >= BAR.afterRepair,
    },
  ];
  if (corpus) {
    lines.push({
      label: `no non-Serbian corpus sample passes the validator (${corpus.nonSerbianPasses.length} passed)`,
      pass: corpus.nonSerbianPasses.length === 0,
    });
  }
  return lines;
}
