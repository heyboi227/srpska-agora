import { DomainError } from "./errors";

/**
 * Who is asking. Services decide what each actor may do; the model never
 * chooses the actor, the server does, and every mutation names one.
 */
export type Actor =
  | { kind: "persona"; personaId: string; accountId: string }
  | { kind: "admin"; accountId: string }
  | { kind: "system" };

export const SYSTEM_ACTOR: Actor = { kind: "system" };

export function requirePersona(
  actor: Actor,
  what: string,
): Extract<Actor, { kind: "persona" }> {
  if (actor.kind !== "persona") {
    throw new DomainError("forbidden", `Only a persona may ${what}.`, { actor: actor.kind });
  }
  return actor;
}

export function requireAdminOrSystem(actor: Actor, what: string): void {
  if (actor.kind !== "admin" && actor.kind !== "system") {
    throw new DomainError("forbidden", `Only the administrator or the system may ${what}.`, {
      actor: actor.kind,
    });
  }
}

export function actorAccountId(actor: Actor): string | null {
  return actor.kind === "system" ? null : actor.accountId;
}
