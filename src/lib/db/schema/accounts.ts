import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { accountRoleEnum } from "./enums";

const timestamps = {
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
};

/** Every actor that can own content or sign in: the administrator, bot identities, system. */
export const accounts = pgTable("accounts", {
  id: uuid().primaryKey().defaultRandom(),
  username: varchar({ length: 64 }).notNull().unique(),
  role: accountRoleEnum().notNull(),
  /** scrypt hash for admins; null for bot and system accounts, which cannot sign in. */
  passwordHash: text(),
  isActive: boolean().notNull().default(true),
  lastLoginAt: timestamp({ withTimezone: true }),
  ...timestamps,
});

/** Opaque session tokens are stored hashed; the cookie carries the raw token. */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid().primaryKey().defaultRandom(),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    tokenHash: varchar({ length: 64 }).notNull().unique(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    ipAddress: varchar({ length: 64 }),
    userAgent: varchar({ length: 256 }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("sessions_account_idx").on(table.accountId, table.expiresAt)],
);

/** Login throttling state keyed by "ip:<address>" and "user:<username>". */
export const loginAttempts = pgTable("login_attempts", {
  key: varchar({ length: 160 }).primaryKey(),
  failures: integer().notNull().default(0),
  windowStartedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  lockedUntil: timestamp({ withTimezone: true }),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
