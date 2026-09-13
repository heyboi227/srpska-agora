import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sourceAccessEnum } from "./enums";

export interface FetchPolicy {
  intervalMinutes: number;
  maxItemsPerFetch: number;
  /** Store only links, metadata, and short excerpts; never mirror full articles. */
  storeExcerptsOnly: true;
}

/** The configurable source registry. Fixture sources are demo data and say so. */
export const sources = pgTable("sources", {
  id: uuid().primaryKey().defaultRandom(),
  slug: varchar({ length: 64 }).notNull().unique(),
  publisherName: varchar({ length: 120 }).notNull(),
  websiteUrl: text().notNull(),
  /** Verified feed or access endpoint; null until verified in Phase 3. */
  feedUrl: text(),
  accessKind: sourceAccessEnum().notNull(),
  category: varchar({ length: 40 }).notNull(),
  language: varchar({ length: 16 }).notNull(),
  ownershipGroup: varchar({ length: 120 }),
  fetchPolicy: jsonb().$type<FetchPolicy>().notNull(),
  isEnabled: boolean().notNull().default(false),
  isFixture: boolean().notNull().default(false),
  lastSuccessfulFetchAt: timestamp({ withTimezone: true }),
  lastAttemptAt: timestamp({ withTimezone: true }),
  lastError: text(),
  /** Serbian note about access conditions and what may be reused. */
  accessNotes: text().notNull().default(""),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/**
 * A retrieved item: link, metadata, and a concise Serbian summary. Publication,
 * source update, retrieval, and event times are kept apart so freshness can be
 * judged from publication, never from retrieval.
 */
export const articles = pgTable(
  "articles",
  {
    id: uuid().primaryKey().defaultRandom(),
    sourceId: uuid()
      .notNull()
      .references(() => sources.id, { onDelete: "restrict" }),
    canonicalUrl: text().notNull().unique(),
    title: text().notNull(),
    /** Serbian, concise, written by the research service (or a fixture). */
    summary: text().notNull(),
    language: varchar({ length: 16 }).notNull(),
    publishedAt: timestamp({ withTimezone: true }).notNull(),
    updatedAtSource: timestamp({ withTimezone: true }),
    retrievedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    eventAt: timestamp({ withTimezone: true }),
    isFixture: boolean().notNull().default(false),
    contentHash: varchar({ length: 64 }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("articles_source_published_idx").on(table.sourceId, table.publishedAt),
    index("articles_published_idx").on(table.publishedAt),
  ],
);
