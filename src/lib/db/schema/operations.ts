import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { accounts } from "./accounts";
import { communities } from "./communities";
import { actionStatusEnum, actionTypeEnum, configChangeKindEnum } from "./enums";
import { personas } from "./personas";

/**
 * One row per attempted forum action, keyed by a stable action key so a retried
 * or replayed job finds its earlier outcome instead of publishing twice.
 */
export const agentActions = pgTable(
  "agent_actions",
  {
    id: uuid().primaryKey().defaultRandom(),
    actionKey: varchar({ length: 160 }).notNull().unique(),
    actionType: actionTypeEnum().notNull(),
    status: actionStatusEnum().notNull().default("proposed"),
    personaId: uuid().references(() => personas.id, { onDelete: "set null" }),
    actorAccountId: uuid().references(() => accounts.id, { onDelete: "set null" }),
    communityId: uuid().references(() => communities.id, { onDelete: "set null" }),
    threadId: uuid(),
    targetId: uuid(),
    intent: varchar({ length: 40 }),
    /** The proposed payload, persisted before publication so recovery can inspect it. */
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    /** Concise decision codes from the gates, e.g. ["english_text"]. */
    decisionCodes: text().array().notNull().default([]),
    /** Structured gate report: language assessment, topical markers, validator verdict. */
    gateReport: jsonb().$type<Record<string, unknown>>(),
    /** Id of the thread, comment, or vote the action produced. */
    resultId: uuid(),
    attempt: integer().notNull().default(1),
    error: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp({ withTimezone: true }),
  },
  (table) => [
    index("agent_actions_status_created_idx").on(table.status, table.createdAt),
    index("agent_actions_persona_created_idx").on(table.personaId, table.createdAt),
    index("agent_actions_thread_idx").on(table.threadId),
  ],
);

/** Versioned configuration; exactly one revision is active at any time. */
export const configRevisions = pgTable(
  "config_revisions",
  {
    id: uuid().primaryKey().defaultRandom(),
    revision: integer().notNull().unique(),
    config: jsonb().$type<Record<string, unknown>>().notNull(),
    changeKind: configChangeKindEnum().notNull(),
    changedByAccountId: uuid().references(() => accounts.id, { onDelete: "set null" }),
    reason: text().notNull().default(""),
    isActive: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("config_revisions_single_active_idx")
      .on(table.isActive)
      .where(sql`${table.isActive} = true`),
  ],
);

/** Liveness of worker processes, shown in the administration area. */
export const workerHeartbeats = pgTable("worker_heartbeats", {
  workerId: varchar({ length: 80 }).primaryKey(),
  hostname: varchar({ length: 120 }).notNull(),
  version: varchar({ length: 40 }).notNull(),
  startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  details: jsonb().$type<Record<string, unknown>>(),
});
