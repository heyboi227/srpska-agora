import {
  bigint,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/** Money is integer micro-USD (1 USD = 1,000,000) so sums never drift. */
const micros = () => bigint({ mode: "number" });

export const budgetPeriodKindEnum = pgEnum("budget_period_kind", ["day", "month"]);

export const costReservationStatusEnum = pgEnum("cost_reservation_status", [
  "open",
  "settled",
  "released",
  "ambiguous",
]);

export const providerRequestStatusEnum = pgEnum("provider_request_status", [
  "reserved",
  "succeeded",
  "failed",
  "ambiguous",
  "rejected",
]);

export const providerPurposeEnum = pgEnum("provider_purpose", [
  "generation",
  "repair",
  "validation",
  "search",
]);

export const providerRequestOriginEnum = pgEnum("provider_request_origin", [
  "scheduler",
  "admin",
  "system",
  "eval",
  "simulation",
]);

/** A day or month window with its spend limit and running totals. */
export const budgetPeriods = pgTable(
  "budget_periods",
  {
    id: uuid().primaryKey().defaultRandom(),
    kind: budgetPeriodKindEnum().notNull(),
    periodStart: timestamp({ withTimezone: true }).notNull(),
    periodEnd: timestamp({ withTimezone: true }).notNull(),
    limitMicros: micros().notNull(),
    reservedMicros: micros().notNull().default(0),
    spentMicros: micros().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("budget_periods_kind_start_uq").on(t.kind, t.periodStart)],
);

/** Every paid (or would-be paid) provider call, including rejected ones. */
export const providerRequests = pgTable(
  "provider_requests",
  {
    id: uuid().primaryKey().defaultRandom(),
    actionKey: varchar({ length: 160 }),
    purpose: providerPurposeEnum().notNull(),
    origin: providerRequestOriginEnum().notNull(),
    provider: varchar({ length: 40 }).notNull(),
    model: varchar({ length: 80 }).notNull(),
    status: providerRequestStatusEnum().notNull(),
    rejectReason: varchar({ length: 60 }),
    estimatedInputTokens: integer().notNull(),
    maxOutputTokens: integer().notNull(),
    inputTokens: integer(),
    cachedInputTokens: integer(),
    outputTokens: integer(),
    reasoningTokens: integer(),
    estimatedMicros: micros().notNull(),
    actualMicros: micros(),
    latencyMs: integer(),
    error: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("provider_requests_created_at_idx").on(t.createdAt),
    index("provider_requests_action_key_idx").on(t.actionKey),
    index("provider_requests_status_idx").on(t.status, t.createdAt),
  ],
);

/** Budget held for one provider request until it settles or is released. */
export const costReservations = pgTable(
  "cost_reservations",
  {
    id: uuid().primaryKey().defaultRandom(),
    providerRequestId: uuid()
      .notNull()
      .unique()
      .references(() => providerRequests.id, { onDelete: "cascade" }),
    dayPeriodId: uuid()
      .notNull()
      .references(() => budgetPeriods.id),
    monthPeriodId: uuid()
      .notNull()
      .references(() => budgetPeriods.id),
    amountMicros: micros().notNull(),
    actualMicros: micros(),
    status: costReservationStatusEnum().notNull().default("open"),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp({ withTimezone: true }),
  },
  (t) => [index("cost_reservations_status_idx").on(t.status, t.createdAt)],
);
