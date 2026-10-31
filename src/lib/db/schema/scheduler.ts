import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { communities } from "./communities";
import { personas } from "./personas";

export const schedulerActionKindEnum = pgEnum("scheduler_action_kind", [
  "thread",
  "reply",
  "revision",
  "summary",
  "vote",
]);

export const budgetStageEnum = pgEnum("budget_stage", [
  "normal",
  "reduced",
  "minimal",
  "paused",
]);

export const schedulerRunStateEnum = pgEnum("scheduler_run_state", [
  "planned",
  "idle",
  "paused",
  "backpressure",
  "skipped_interval",
  "error",
]);

export const schedulerDecisionOutcomeEnum = pgEnum("scheduler_decision_outcome", [
  "queued",
  "published",
  "quarantined",
  "skipped",
  "failed",
]);

/** Why a candidate scored what it did: every feature with its weight and contribution. */
export interface ScoreBreakdown {
  features: {
    key: string;
    label: string;
    value: number;
    weight: number;
    contribution: number;
  }[];
  base: number;
  stageFactor: number;
  total: number;
}

/** One row per scheduler tick, recorded whether or not it planned anything. */
export const schedulerRuns = pgTable(
  "scheduler_runs",
  {
    id: uuid().primaryKey().defaultRandom(),
    tickAt: timestamp({ withTimezone: true }).notNull(),
    state: schedulerRunStateEnum().notNull(),
    budgetStage: budgetStageEnum().notNull(),
    plannedCount: integer().notNull().default(0),
    candidateCount: integer().notNull().default(0),
    details: jsonb().$type<Record<string, unknown>>(),
    durationMs: integer(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("scheduler_runs_tick_at_idx").on(t.tickAt)],
);

/** One row per planned action, with the score breakdown that justified it. */
export const schedulerDecisions = pgTable(
  "scheduler_decisions",
  {
    id: uuid().primaryKey().defaultRandom(),
    runId: uuid()
      .notNull()
      .references(() => schedulerRuns.id, { onDelete: "cascade" }),
    kind: schedulerActionKindEnum().notNull(),
    actionKey: varchar({ length: 160 }).notNull().unique(),
    personaId: uuid().references(() => personas.id, { onDelete: "set null" }),
    communityId: uuid().references(() => communities.id, { onDelete: "set null" }),
    threadId: uuid(),
    targetId: uuid(),
    intent: varchar({ length: 40 }),
    score: doublePrecision().notNull(),
    probability: doublePrecision(),
    breakdown: jsonb().$type<ScoreBreakdown>().notNull(),
    outcome: schedulerDecisionOutcomeEnum().notNull().default("queued"),
    outcomeCode: varchar({ length: 60 }),
    jobId: varchar({ length: 64 }),
    actionId: uuid(),
    notAfter: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("scheduler_decisions_created_at_idx").on(t.createdAt),
    index("scheduler_decisions_outcome_idx").on(t.outcome, t.createdAt),
    index("scheduler_decisions_persona_idx").on(t.personaId, t.createdAt),
    index("scheduler_decisions_thread_idx").on(t.threadId),
  ],
);
