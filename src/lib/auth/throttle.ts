import { eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import { loginAttempts } from "@/lib/db/schema";

/**
 * Login throttling keyed by client address and by username, so neither a
 * single attacker nor a distributed guess against one account gets unlimited
 * tries. Lockouts grow with repeated failures and reset after a quiet window.
 */

const WINDOW_MS = 15 * 60 * 1000;
const LOCK_AFTER_FAILURES = 5;
const LOCK_STEPS_MS = [5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000];

export function throttleKeys(ipAddress: string | null | undefined, username: string): string[] {
  const keys = [`user:${username.toLowerCase().slice(0, 100)}`];
  if (ipAddress) keys.push(`ip:${ipAddress.slice(0, 100)}`);
  return keys;
}

/** Returns the instant until which login is blocked, or null when allowed. */
export async function loginLockedUntil(
  db: DbOrTx,
  keys: string[],
  now: Date = new Date(),
): Promise<Date | null> {
  if (keys.length === 0) return null;
  const rows = await db
    .select({ lockedUntil: loginAttempts.lockedUntil })
    .from(loginAttempts)
    .where(inArray(loginAttempts.key, keys));
  let latest: Date | null = null;
  for (const row of rows) {
    if (row.lockedUntil && row.lockedUntil > now && (!latest || row.lockedUntil > latest)) {
      latest = row.lockedUntil;
    }
  }
  return latest;
}

export async function recordLoginFailure(
  db: DbOrTx,
  keys: string[],
  now: Date = new Date(),
): Promise<void> {
  for (const key of keys) {
    const rows = await db
      .select()
      .from(loginAttempts)
      .where(eq(loginAttempts.key, key))
      .limit(1);
    const existing = rows[0];
    const withinWindow = existing
      ? now.getTime() - existing.windowStartedAt.getTime() < WINDOW_MS
      : false;
    const failures = withinWindow && existing ? existing.failures + 1 : 1;
    let lockedUntil: Date | null = null;
    if (failures >= LOCK_AFTER_FAILURES) {
      const step = Math.min(failures - LOCK_AFTER_FAILURES, LOCK_STEPS_MS.length - 1);
      lockedUntil = new Date(now.getTime() + (LOCK_STEPS_MS[step] as number));
    }
    await db
      .insert(loginAttempts)
      .values({
        key,
        failures,
        windowStartedAt: withinWindow && existing ? existing.windowStartedAt : now,
        lockedUntil,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: loginAttempts.key,
        set: {
          failures,
          windowStartedAt: withinWindow && existing ? existing.windowStartedAt : now,
          lockedUntil,
          updatedAt: now,
        },
      });
  }
}

export async function clearLoginFailures(db: DbOrTx, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await db.delete(loginAttempts).where(inArray(loginAttempts.key, keys));
}

export async function pruneLoginAttempts(db: DbOrTx, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const rows = await db
    .delete(loginAttempts)
    .where(
      sql`${loginAttempts.updatedAt} < ${cutoff} and (${loginAttempts.lockedUntil} is null or ${loginAttempts.lockedUntil} < ${now})`,
    )
    .returning({ key: loginAttempts.key });
  return rows.length;
}
