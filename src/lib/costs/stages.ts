import type { ActionKind } from "@/lib/jobs/types";

export type BudgetStage = "normal" | "reduced" | "minimal" | "paused";

/**
 * "Remaining" is the lower of the day and month remaining allowances. The
 * stage is paused once the remainder cannot pay for one more action: at or
 * below 5 % of the daily limit, or at or below `actionReserveMicros` (twice the
 * recent average estimate of one call), whichever is larger. Without that, a
 * small daily limit leaves the stage at "minimal" while the gateway refuses
 * every call.
 */
export function budgetStageFor(input: {
  remainingMicros: number;
  dailyLimitMicros: number;
  pausePaidActions: boolean;
  actionReserveMicros?: number;
}): BudgetStage {
  const { remainingMicros, dailyLimitMicros, pausePaidActions } = input;
  if (pausePaidActions || dailyLimitMicros <= 0) return "paused";
  const share = remainingMicros / dailyLimitMicros;
  const reserve = input.actionReserveMicros ?? 0;
  if (share <= 0.05 || remainingMicros <= reserve) return "paused";
  if (share <= 0.2) return "minimal";
  if (share <= 0.4) return "reduced";
  return "normal";
}

export interface StageFlags {
  affinity: number;
  freshEvidence: boolean;
  answersOpenQuestion: boolean;
}

/** Multiplier on a candidate's score; 0 removes the candidate. Votes make no paid call. */
export function stageFactor(stage: BudgetStage, kind: ActionKind, flags: StageFlags): number {
  if (kind === "vote") return 1;
  switch (stage) {
    case "normal":
      return 1;
    case "reduced":
      if (kind === "thread") return flags.affinity < 4 ? 0 : 0.5;
      if (kind === "reply") return 0.6;
      return 1;
    case "minimal":
      if (kind === "thread") return flags.freshEvidence ? 0.3 : 0;
      if (kind === "reply") return flags.answersOpenQuestion || flags.freshEvidence ? 1 : 0;
      if (kind === "summary") return 1;
      return 0;
    case "paused":
      return 0;
  }
}

export const STAGE_LABELS: Record<BudgetStage, string> = {
  normal: "normalno",
  reduced: "smanjeno",
  minimal: "minimalno",
  paused: "pauzirano",
};

export const STAGE_EXPLANATIONS: Record<BudgetStage, string> = {
  normal: "Preostalo je dovoljno budžeta, pa sagovornici rade punim tempom.",
  reduced:
    "Budžet se približava kraju: manje novih tema u zajednicama sa niskim afinitetom i manje komentara.",
  minimal:
    "Budžet je skoro potrošen: samo odgovori na otvorena pitanja, teme sa svežim izvorima i dospeli rezimei.",
  paused:
    "Plaćeni rad je zaustavljen; glasanje i čitanje se nastavljaju, a rad se vraća kada se budžet obnovi.",
};
