import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import { accounts, sessions } from "@/lib/db/schema";

/**
 * Opaque, database-backed sessions. The cookie carries a random token; the
 * database stores only its SHA-256, so a leaked database dump cannot be
 * replayed as a session. Expiry is sliding: activity extends the session.
 */

export const SESSION_COOKIE = "agora_session";
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

export interface SessionAccount {
  id: string;
  username: string;
  role: "admin" | "bot" | "system";
}

export interface SessionInfo {
  sessionId: string;
  account: SessionAccount;
  expiresAt: Date;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(
  db: DbOrTx,
  accountId: string,
  meta: { ipAddress?: string | null; userAgent?: string | null } = {},
  now: Date = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.insert(sessions).values({
    accountId,
    tokenHash: hashToken(token),
    expiresAt,
    lastSeenAt: now,
    ipAddress: meta.ipAddress?.slice(0, 64) ?? null,
    userAgent: meta.userAgent?.slice(0, 256) ?? null,
  });
  return { token, expiresAt };
}

/** Resolves a raw token to an active administrator session, extending it when stale. */
export async function validateSession(
  db: DbOrTx,
  token: string | undefined,
  now: Date = new Date(),
): Promise<SessionInfo | null> {
  if (!token || token.length < 20) return null;
  const rows = await db
    .select({
      sessionId: sessions.id,
      expiresAt: sessions.expiresAt,
      lastSeenAt: sessions.lastSeenAt,
      accountId: accounts.id,
      username: accounts.username,
      role: accounts.role,
      isActive: accounts.isActive,
    })
    .from(sessions)
    .innerJoin(accounts, eq(accounts.id, sessions.accountId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, now)))
    .limit(1);
  const row = rows[0];
  if (!row || !row.isActive) return null;

  let expiresAt = row.expiresAt;
  if (now.getTime() - row.lastSeenAt.getTime() > REFRESH_AFTER_MS) {
    expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await db
      .update(sessions)
      .set({ lastSeenAt: now, expiresAt })
      .where(eq(sessions.id, row.sessionId));
  }
  return {
    sessionId: row.sessionId,
    account: { id: row.accountId, username: row.username, role: row.role },
    expiresAt,
  };
}

export async function revokeSession(db: DbOrTx, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

export async function revokeAllSessions(db: DbOrTx, accountId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.accountId, accountId));
}

export async function deleteExpiredSessions(db: DbOrTx, now: Date = new Date()): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, now));
}
