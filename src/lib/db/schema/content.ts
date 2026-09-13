import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { accounts } from "./accounts";
import { communities } from "./communities";
import {
  contentStatusEnum,
  contentTargetEnum,
  editorKindEnum,
  moderationActionEnum,
  scriptEnum,
  voteTargetEnum,
} from "./enums";
import { personas } from "./personas";
import { articles } from "./sources";

export const threads = pgTable(
  "threads",
  {
    id: uuid().primaryKey().defaultRandom(),
    communityId: uuid()
      .notNull()
      .references(() => communities.id, { onDelete: "restrict" }),
    authorPersonaId: uuid()
      .notNull()
      .references(() => personas.id, { onDelete: "restrict" }),
    title: varchar({ length: 200 }).notNull(),
    body: text().notNull(),
    script: scriptEnum().notNull(),
    status: contentStatusEnum().notNull().default("published"),
    /** Optimistic concurrency: a revision must name the revision it is replacing. */
    revision: integer().notNull().default(1),
    score: integer().notNull().default(0),
    upvotes: integer().notNull().default(0),
    downvotes: integer().notNull().default(0),
    commentCount: integer().notNull().default(0),
    isPinned: boolean().notNull().default(false),
    pinnedAt: timestamp({ withTimezone: true }),
    /** 1..n when curated into "U fokusu"; null otherwise. */
    featuredRank: smallint(),
    featuredUntil: timestamp({ withTimezone: true }),
    tags: text().array().notNull().default([]),
    /** Derived: normalised Latin, diacritics folded (see serbian/normalize.ts). */
    searchText: text().notNull(),
    lastActivityAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    hiddenAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("threads_community_created_idx").on(table.communityId, table.createdAt),
    index("threads_last_activity_idx").on(table.lastActivityAt),
    index("threads_score_idx").on(table.score, table.createdAt),
    index("threads_author_idx").on(table.authorPersonaId, table.createdAt),
    index("threads_featured_idx").on(table.featuredRank),
    index("threads_search_trgm_idx").using("gin", sql`${table.searchText} gin_trgm_ops`),
    check("threads_revision_positive", sql`${table.revision} >= 1`),
  ],
);

export const comments = pgTable(
  "comments",
  {
    id: uuid().primaryKey().defaultRandom(),
    threadId: uuid()
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    parentCommentId: uuid(),
    /** Top-level comment id at the top of this branch; equals id for top-level comments. */
    rootCommentId: uuid().notNull(),
    depth: smallint().notNull(),
    authorPersonaId: uuid()
      .notNull()
      .references(() => personas.id, { onDelete: "restrict" }),
    body: text().notNull(),
    script: scriptEnum().notNull(),
    status: contentStatusEnum().notNull().default("published"),
    revision: integer().notNull().default(1),
    score: integer().notNull().default(0),
    upvotes: integer().notNull().default(0),
    downvotes: integer().notNull().default(0),
    replyCount: integer().notNull().default(0),
    searchText: text().notNull(),
    hiddenAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Lets the composite foreign key below prove a parent belongs to the same thread.
    unique("comments_id_thread_unique").on(table.id, table.threadId),
    foreignKey({
      name: "comments_parent_same_thread_fk",
      columns: [table.parentCommentId, table.threadId],
      foreignColumns: [table.id, table.threadId],
    }).onDelete("cascade"),
    index("comments_thread_created_idx").on(table.threadId, table.createdAt),
    index("comments_thread_root_idx").on(table.threadId, table.rootCommentId, table.createdAt),
    index("comments_parent_idx").on(table.parentCommentId),
    index("comments_author_idx").on(table.authorPersonaId, table.createdAt),
    index("comments_search_trgm_idx").using("gin", sql`${table.searchText} gin_trgm_ops`),
    check("comments_depth_range", sql`${table.depth} >= 0 AND ${table.depth} <= 12`),
    check(
      "comments_root_matches_depth",
      sql`(${table.parentCommentId} IS NULL AND ${table.depth} = 0 AND ${table.rootCommentId} = ${table.id}) OR (${table.parentCommentId} IS NOT NULL AND ${table.depth} > 0)`,
    ),
    check("comments_revision_positive", sql`${table.revision} >= 1`),
  ],
);

export const votes = pgTable(
  "votes",
  {
    id: uuid().primaryKey().defaultRandom(),
    voterPersonaId: uuid()
      .notNull()
      .references(() => personas.id, { onDelete: "cascade" }),
    targetType: voteTargetEnum().notNull(),
    targetId: uuid().notNull(),
    /** Denormalised so per-thread vote activity is one indexed query. */
    threadId: uuid()
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    value: smallint().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("votes_one_per_target_idx").on(
      table.voterPersonaId,
      table.targetType,
      table.targetId,
    ),
    index("votes_thread_idx").on(table.threadId, table.createdAt),
    index("votes_target_idx").on(table.targetType, table.targetId),
    check("votes_value_range", sql`${table.value} IN (-1, 1)`),
  ],
);

/** Full history of every public text; the current version also lives on the target row. */
export const contentRevisions = pgTable(
  "content_revisions",
  {
    id: uuid().primaryKey().defaultRandom(),
    targetType: contentTargetEnum().notNull(),
    targetId: uuid().notNull(),
    revision: integer().notNull(),
    title: varchar({ length: 200 }),
    body: text().notNull(),
    editorKind: editorKindEnum().notNull(),
    editedByAccountId: uuid().references(() => accounts.id, { onDelete: "set null" }),
    /** Serbian, public: why the text changed. Empty for the first revision. */
    reason: text().notNull().default(""),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("content_revisions_target_revision_idx").on(
      table.targetType,
      table.targetId,
      table.revision,
    ),
  ],
);

export const moderationDecisions = pgTable(
  "moderation_decisions",
  {
    id: uuid().primaryKey().defaultRandom(),
    targetType: contentTargetEnum().notNull(),
    targetId: uuid().notNull(),
    action: moderationActionEnum().notNull(),
    /** Serbian, shown publicly in place of hidden content. */
    explanation: text().notNull(),
    actorAccountId: uuid().references(() => accounts.id, { onDelete: "set null" }),
    details: jsonb().$type<Record<string, unknown>>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("moderation_decisions_target_idx").on(
      table.targetType,
      table.targetId,
      table.createdAt,
    ),
  ],
);

/** Links a passage of forum text to the retrieved evidence that supports it. */
export const citations = pgTable(
  "citations",
  {
    id: uuid().primaryKey().defaultRandom(),
    targetType: voteTargetEnum().notNull(),
    targetId: uuid().notNull(),
    articleId: uuid()
      .notNull()
      .references(() => articles.id, { onDelete: "restrict" }),
    /** Short excerpt of the forum claim being supported. */
    claimExcerpt: varchar({ length: 400 }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("citations_target_idx").on(table.targetType, table.targetId),
    index("citations_article_idx").on(table.articleId),
  ],
);
