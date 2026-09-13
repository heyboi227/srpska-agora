import { describe, expect, it } from "vitest";
import { loginWithPassword, upsertAdminAccount } from "@/lib/auth/login";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { revokeSession, validateSession } from "@/lib/auth/session";
import { testDb } from "./helpers";

const PASSWORD = "correct-horse-battery-staple";

describe("passwords", () => {
  it("hashes with scrypt and verifies in constant time", async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash.startsWith("scrypt$32768$8$1$")).toBe(true);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyPassword("wrong-password-here", hash)).toBe(false);
    expect(await verifyPassword(PASSWORD, "garbage")).toBe(false);
  });
  it("refuses short passwords", async () => {
    await expect(hashPassword("short")).rejects.toThrow();
  });
});

describe("administrator login", () => {
  it("signs in, validates the session, and revokes it", async () => {
    const db = testDb();
    const created = await upsertAdminAccount(db, { username: "admin", password: PASSWORD });
    expect(created.created).toBe(true);

    const login = await loginWithPassword(db, {
      username: "admin",
      password: PASSWORD,
      ipAddress: "127.0.0.1",
    });
    expect(login.ok).toBe(true);
    if (!login.ok) return;

    const session = await validateSession(db, login.token);
    expect(session?.account.username).toBe("admin");
    expect(session?.account.role).toBe("admin");

    await revokeSession(db, login.token);
    expect(await validateSession(db, login.token)).toBeNull();
    expect(await validateSession(db, "not-a-real-token-at-all")).toBeNull();
  });

  it("throttles after repeated failures and does not reveal unknown usernames", async () => {
    const db = testDb();
    await upsertAdminAccount(db, { username: "admin", password: PASSWORD });
    const now = new Date("2026-09-10T10:00:00Z");

    for (let i = 0; i < 4; i += 1) {
      const attempt = await loginWithPassword(
        db,
        { username: "admin", password: "wrong-password-here", ipAddress: "10.0.0.1" },
        now,
      );
      expect(attempt).toEqual({ ok: false, reason: "invalid" });
    }
    const fifth = await loginWithPassword(
      db,
      { username: "admin", password: "wrong-password-here", ipAddress: "10.0.0.1" },
      now,
    );
    expect(fifth).toEqual({ ok: false, reason: "invalid" });

    const locked = await loginWithPassword(
      db,
      { username: "admin", password: PASSWORD, ipAddress: "10.0.0.1" },
      now,
    );
    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.reason).toBe("locked");

    const later = new Date(now.getTime() + 6 * 60 * 1000);
    const unlocked = await loginWithPassword(
      db,
      { username: "admin", password: PASSWORD, ipAddress: "10.0.0.1" },
      later,
    );
    expect(unlocked.ok).toBe(true);

    const unknown = await loginWithPassword(
      db,
      { username: "nobody", password: PASSWORD, ipAddress: "10.0.0.2" },
      later,
    );
    expect(unknown).toEqual({ ok: false, reason: "invalid" });
  });

  it("does not sign in bot accounts or promote them", async () => {
    const db = testDb();
    await upsertAdminAccount(db, { username: "admin", password: PASSWORD });
    const login = await loginWithPassword(db, { username: "bot:slavica", password: PASSWORD });
    expect(login.ok).toBe(false);
  });
});
