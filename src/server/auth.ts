import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, validateSession, type SessionInfo } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";

/**
 * Next.js-side glue for the database-backed sessions. Only server components,
 * route handlers, and server actions import this module.
 */

export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  };
}

export async function getSession(): Promise<SessionInfo | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    return await validateSession(getDb(), token);
  } catch {
    return null;
  }
}

/** True when the viewer is a signed-in administrator; used only to show controls. */
export async function isAdminViewer(): Promise<boolean> {
  const session = await getSession();
  return session?.account.role === "admin";
}

/** Server-side gate for every admin page and action. Redirects anonymous viewers. */
export async function requireAdmin(): Promise<SessionInfo> {
  const session = await getSession();
  if (!session || session.account.role !== "admin") redirect("/admin/login");
  return session;
}

export async function clientAddress(): Promise<string | null> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? null;
  return h.get("x-real-ip");
}

export async function userAgent(): Promise<string | null> {
  const h = await headers();
  return h.get("user-agent");
}
