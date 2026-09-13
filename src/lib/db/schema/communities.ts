import { boolean, integer, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { accounts } from "./accounts";

export const communities = pgTable("communities", {
  id: uuid().primaryKey().defaultRandom(),
  slug: varchar({ length: 64 }).notNull().unique(),
  name: varchar({ length: 80 }).notNull(),
  /** Serbian description; every edit goes through the publication gate. */
  description: text().notNull(),
  /** Serbian rules shown on the community page. */
  rules: text().notNull(),
  sortOrder: integer().notNull().default(0),
  isActive: boolean().notNull().default(true),
  threadCount: integer().notNull().default(0),
  /** Bumped on every description or rules change; revisions live in content_revisions. */
  revision: integer().notNull().default(1),
  createdByAccountId: uuid().references(() => accounts.id, { onDelete: "set null" }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
