"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { loginWithPassword } from "@/lib/auth/login";
import { revokeSession, SESSION_COOKIE } from "@/lib/auth/session";
import { getPreset, type PresetName } from "@/lib/config/presets";
import { getActiveConfig, rollbackConfigTo, saveConfigRevision } from "@/lib/config/service";
import { getDb } from "@/lib/db/client";
import { createServiceContext } from "@/lib/domain/context";
import { isDomainError } from "@/lib/domain/errors";
import { discardQuarantinedAction, moderateContent } from "@/lib/domain/moderation";
import { clientAddress, requireAdmin, sessionCookieOptions, userAgent } from "@/server/auth";

/**
 * Administrator server actions. Every action re-checks the session on the
 * server; visibility of a button in the UI grants nothing. Next.js verifies
 * the Origin header of server-action requests, which covers CSRF for forms.
 */

export interface LoginState {
  error?: string;
  /** Echoed back so the form keeps the username after a failed attempt. */
  username?: string;
}

export async function loginAction(
  _previous: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const username = String(formData.get("username") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (username.length === 0 || password.length === 0) {
    return { error: "Unesite korisničko ime i lozinku.", username };
  }
  const result = await loginWithPassword(getDb(), {
    username,
    password,
    ipAddress: await clientAddress(),
    userAgent: await userAgent(),
  });
  if (!result.ok) {
    if (result.reason === "locked") {
      return {
        error: `Previše neuspešnih pokušaja. Pokušajte ponovo posle ${result.lockedUntil.toLocaleTimeString("sr-Latn-RS", { timeZone: "Europe/Belgrade" })}.`,
        username,
      };
    }
    return { error: "Neispravno korisničko ime ili lozinka.", username };
  }
  const store = await cookies();
  store.set(SESSION_COOKIE, result.token, sessionCookieOptions(result.expiresAt));
  redirect("/admin");
}

export async function logoutAction(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    await revokeSession(getDb(), token);
    store.delete(SESSION_COOKIE);
  }
  redirect("/admin/login");
}

export async function setPauseAction(formData: FormData): Promise<void> {
  const session = await requireAdmin();
  const field = String(formData.get("field"));
  const value = String(formData.get("value")) === "true";
  if (field !== "pauseAllActions" && field !== "pausePaidActions") return;
  const db = getDb();
  const config = structuredClone(await getActiveConfig(db));
  config.runtime[field] = value;
  await saveConfigRevision(db, {
    config,
    changeKind: "admin",
    changedByAccountId: session.account.id,
    reason: `${field === "pauseAllActions" ? "Sve akcije" : "Plaćene akcije"}: ${value ? "pauza" : "nastavak"}.`,
  });
  revalidatePath("/admin");
  revalidatePath("/admin/konfiguracija");
}

export async function applyPresetAction(formData: FormData): Promise<void> {
  const session = await requireAdmin();
  const name = String(formData.get("preset"));
  if (name !== "quiet" && name !== "standard") return;
  const db = getDb();
  const current = await getActiveConfig(db);
  const next = getPreset(name as PresetName);
  // A preset changes limits and budgets; it never flips the runtime mode or pause state.
  next.runtime.mode = current.runtime.mode;
  next.runtime.pauseAllActions = current.runtime.pauseAllActions;
  next.runtime.pausePaidActions = current.runtime.pausePaidActions;
  await saveConfigRevision(db, {
    config: next,
    changeKind: "admin",
    changedByAccountId: session.account.id,
    reason: `Primenjen preset „${name}“.`,
  });
  revalidatePath("/admin");
  revalidatePath("/admin/konfiguracija");
}

export async function rollbackConfigAction(formData: FormData): Promise<void> {
  const session = await requireAdmin();
  const revision = Number.parseInt(String(formData.get("revision")), 10);
  if (!Number.isInteger(revision) || revision < 1) return;
  await rollbackConfigTo(getDb(), revision, {
    changedByAccountId: session.account.id,
    reason: `Vraćeno na reviziju ${revision}.`,
  });
  revalidatePath("/admin");
  revalidatePath("/admin/konfiguracija");
}

export async function discardDraftAction(formData: FormData): Promise<void> {
  const session = await requireAdmin();
  const actionId = String(formData.get("actionId"));
  const note = String(formData.get("note") ?? "");
  const ctx = await createServiceContext({ origin: "admin" });
  try {
    await discardQuarantinedAction(
      { actor: { kind: "admin", accountId: session.account.id }, actionId, note },
      ctx,
    );
  } catch (error) {
    if (!isDomainError(error)) throw error;
  }
  revalidatePath("/admin/karantin");
  revalidatePath("/admin");
}

export interface ModerationState {
  error?: string;
  ok?: boolean;
}

export async function moderateAction(
  _previous: ModerationState,
  formData: FormData,
): Promise<ModerationState> {
  const session = await requireAdmin();
  const targetType = String(formData.get("targetType"));
  const targetId = String(formData.get("targetId"));
  const action = String(formData.get("action"));
  const threadId = String(formData.get("threadId"));
  const explanation = String(formData.get("explanation") ?? "").trim();
  if (
    (targetType !== "thread" && targetType !== "comment") ||
    (action !== "hide" && action !== "restore")
  ) {
    return { error: "Nepoznata moderatorska akcija." };
  }
  if (explanation.length < 10) {
    return { error: "Obrazloženje na srpskom je obavezno (najmanje 10 znakova)." };
  }
  const ctx = await createServiceContext({ origin: "admin" });
  try {
    await moderateContent(
      {
        actor: { kind: "admin", accountId: session.account.id },
        targetType,
        targetId,
        action,
        explanation,
      },
      ctx,
    );
  } catch (error) {
    if (isDomainError(error)) {
      const codes = Array.isArray(error.details.codes)
        ? ` (${(error.details.codes as string[]).join(", ")})`
        : "";
      return { error: `${error.message}${codes}` };
    }
    throw error;
  }
  if (/^[0-9a-f-]{36}$/i.test(threadId)) revalidatePath(`/t/${threadId}`);
  revalidatePath("/admin/sadrzaj");
  revalidatePath("/");
  return { ok: true };
}
