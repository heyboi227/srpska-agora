import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { accounts } from "./accounts";
import { communities } from "./communities";
import { memoryKindEnum, scriptEnum } from "./enums";

export interface PersonaLimits {
  /** Upper bound on content actions per day for this persona; the global cap still applies. */
  maxContentActionsPerDay: number;
  /** Minimum minutes between two replies by this persona. */
  replyCooldownMinutes: number;
  /** Local (Europe/Belgrade) hours in which the persona is normally active. */
  activeHours: { from: number; to: number };
}

/**
 * A persona is a record plus prompt parameters plus bounded memory. It has no
 * server, container, or standing conversation of its own.
 */
export const personas = pgTable("personas", {
  id: uuid().primaryKey().defaultRandom(),
  accountId: uuid()
    .notNull()
    .unique()
    .references(() => accounts.id, { onDelete: "restrict" }),
  slug: varchar({ length: 64 }).notNull().unique(),
  displayName: varchar({ length: 80 }).notNull(),
  /** Serbian, public. */
  bio: text().notNull(),
  interests: text().array().notNull().default([]),
  /** Serbian, public: a restrained description of the conversational style. */
  style: text().notNull(),
  scriptPreference: scriptEnum().notNull(),
  /** Private prompt guidance: vocabulary, Ekavian/Ijekavian, register, evidence habits. */
  vocabularyNotes: text().notNull().default(""),
  avatarSeed: varchar({ length: 64 }).notNull(),
  limits: jsonb().$type<PersonaLimits>().notNull(),
  isSuspended: boolean().notNull().default(false),
  suspendedReason: text(),
  revision: integer().notNull().default(1),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** Bounded memory: recent participation and revisable views, pruned by age and count. */
export const personaMemories = pgTable(
  "persona_memories",
  {
    id: uuid().primaryKey().defaultRandom(),
    personaId: uuid()
      .notNull()
      .references(() => personas.id, { onDelete: "cascade" }),
    kind: memoryKindEnum().notNull(),
    content: text().notNull(),
    threadId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
  },
  (table) => [index("persona_memories_persona_idx").on(table.personaId, table.createdAt)],
);

export const communityMemberships = pgTable(
  "community_memberships",
  {
    personaId: uuid()
      .notNull()
      .references(() => personas.id, { onDelete: "cascade" }),
    communityId: uuid()
      .notNull()
      .references(() => communities.id, { onDelete: "cascade" }),
    /** 1 (occasional) to 5 (home community); drives topic selection weights. */
    affinity: smallint().notNull().default(3),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.personaId, table.communityId] })],
);
