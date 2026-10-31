import { stageFactor, type BudgetStage, type StageFlags } from "@/lib/costs/stages";
import type { ScoreBreakdown } from "@/lib/db/schema/scheduler";
import type { ActionKind } from "@/lib/jobs/types";
import type { SeededRandom } from "@/lib/random";
import type { Candidate } from "./candidates";
import { BASE_SCORE, FEATURE_LABELS, IDLE_SCORE, TOP_CANDIDATES, WEIGHTS } from "./weights";

/** `max(0, base + sum(weight * value)) * stageFactor`, with every term recorded. */
export function scoreFeatures(
  kind: ActionKind,
  values: Record<string, number>,
  stage: BudgetStage,
  flags: StageFlags,
): ScoreBreakdown {
  const weights = WEIGHTS[kind] as Record<string, number>;
  const features = Object.entries(weights).map(([key, weight]) => {
    const value = values[key] ?? 0;
    return {
      key,
      label: FEATURE_LABELS[key] ?? key,
      value,
      weight,
      contribution: weight * value,
    };
  });
  const base = BASE_SCORE;
  const factor = stageFactor(stage, kind, flags);
  const sum = features.reduce((acc, f) => acc + f.contribution, base);
  return { features, base, stageFactor: factor, total: Math.max(0, sum) * factor };
}

export interface ScoredCandidate extends Candidate {
  score: number;
  breakdown: ScoreBreakdown;
}

/** Scores candidates and drops those the budget stage removes (stage factor 0). */
export function scoreCandidates(
  candidates: Candidate[],
  stage: BudgetStage,
): ScoredCandidate[] {
  const scored: ScoredCandidate[] = [];
  for (const c of candidates) {
    const breakdown = scoreFeatures(c.kind, c.values, stage, c.flags);
    if (breakdown.stageFactor === 0) continue;
    scored.push({ ...c, score: breakdown.total, breakdown });
  }
  return rank(scored);
}

/** Best first; ties break on a stable key so the same inputs always rank the same way. */
export function rank<T extends { score: number; sortKey: string }>(items: T[]): T[] {
  return [...items].sort((a, b) =>
    b.score !== a.score
      ? b.score - a.score
      : a.sortKey < b.sortKey
        ? -1
        : a.sortKey > b.sortKey
          ? 1
          : 0,
  );
}

export interface Choice {
  /** Null when the idle pseudo-candidate won, or when nothing was a candidate at all. */
  chosen: ScoredCandidate | null;
  /** Probability the recorded choice had: score / sum of scores (idle included). */
  probability: number;
}

/** One seeded weighted draw among the top candidates plus the idle baseline. */
export function chooseAmong(ranked: ScoredCandidate[], rng: SeededRandom): Choice {
  const top = ranked.filter((c) => c.score > 0).slice(0, TOP_CANDIDATES);
  if (top.length === 0) return { chosen: null, probability: 1 };
  const total = top.reduce((acc, c) => acc + c.score, IDLE_SCORE);
  let point = rng.next() * total;
  for (const c of top) {
    if (point < c.score) return { chosen: c, probability: c.score / total };
    point -= c.score;
  }
  return { chosen: null, probability: IDLE_SCORE / total };
}
