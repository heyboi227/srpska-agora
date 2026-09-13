import { eq } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import { accounts } from "@/lib/db/schema";
import { hashPassword, verifyPassword } from "./password";
import { createSession } from "./session";
import {
  clearLoginFailures,
  loginLockedUntil,
  recordLoginFailure,
  throttleKeys,
} from "./throttle";

export type LoginResult =
  | { ok: true; token: string; expiresAt: Date; accountId: string }
  | { ok: false; reason: "locked"; lockedUntil: Date }
  | { ok: false; reason: "invalid" };

/**
 * Username and password sign-in for administrator accounts only. A wrong
 * password and an unknown username take the same path so the response does
 * not reveal which accounts exist.
 */
export async function loginWithPassword(
  db: DbOrTx,
  params: {
    username: string;
    password: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
  now: Date = new Date(),
): Promise<LoginResult> {
  const username = params.username.trim();
  const keys = throttleKeys(params.ipAddress, username);
  const lockedUntil = await loginLockedUntil(db, keys, now);
  if (lockedUntil) return { ok: false, reason: "locked", lockedUntil };

  const rows = await db.select().from(accounts).where(eq(accounts.username, username)).limit(1);
  const account = rows[0];
  const valid =
    account !== undefined &&
    account.isActive &&
    account.role === "admin" &&
    account.passwordHash !== null &&
    (await verifyPassword(params.password, account.passwordHash));

  if (!valid || !account) {
    await recordLoginFailure(db, keys, now);
    return { ok: false, reason: "invalid" };
  }

  await clearLoginFailures(db, keys);
  await db.update(accounts).set({ lastLoginAt: now }).where(eq(accounts.id, account.id));
  const session = await createSession(
    db,
    account.id,
    { ipAddress: params.ipAddress, userAgent: params.userAgent },
    now,
  );
  return {
    ok: true,
    token: session.token,
    expiresAt: session.expiresAt,
    accountId: account.id,
  };
}

/** Creates or updates the administrator account. There is never a default password. */
export async function upsertAdminAccount(
  db: DbOrTx,
  params: { username: string; password: string },
): Promise<{ id: string; created: boolean }> {
  const passwordHash = await hashPassword(params.password);
  const existing = await db
    .select({ id: accounts.id, role: accounts.role })
    .from(accounts)
    .where(eq(accounts.username, params.username))
    .limit(1);
  const row = existing[0];
  if (row) {
    if (row.role !== "admin") {
      throw new Error(
        `Account "${params.username}" exists with role ${row.role}; refusing to promote it.`,
      );
    }
    await db
      .update(accounts)
      .set({ passwordHash, isActive: true, updatedAt: new Date() })
      .where(eq(accounts.id, row.id));
    return { id: row.id, created: false };
  }
  const [inserted] = await db
    .insert(accounts)
    .values({ username: params.username, role: "admin", passwordHash })
    .returning({ id: accounts.id });
  if (!inserted) throw new Error("Admin insert returned no row.");
  return { id: inserted.id, created: true };
}
