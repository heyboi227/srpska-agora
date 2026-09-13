import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import {
  accounts,
  communities,
  communityMemberships,
  contentRevisions,
  personaMemories,
  personas,
  type PersonaLimits,
} from "@/lib/db/schema";
import { runPublicationGate } from "@/lib/gates/publication-gate";
import { actorAccountId, requireAdminOrSystem, type Actor } from "./actors";
import type { ServiceContext } from "./context";
import { DomainError } from "./errors";

export type PersonaRow = typeof personas.$inferSelect;

export interface CreatePersonaParams {
  actor: Actor;
  slug: string;
  displayName: string;
  bio: string;
  interests: string[];
  style: string;
  scriptPreference: "Latin" | "Cyrillic";
  vocabularyNotes: string;
  limits: PersonaLimits;
  memberships: { communitySlug: string; affinity: number }[];
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Bounded memory: keep at most this many entries per persona. */
export const MAX_MEMORIES_PER_PERSONA = 60;
const MEMORY_TTL_MS = 45 * 24 * 60 * 60 * 1000;

export async function createPersona(
  params: CreatePersonaParams,
  ctx: ServiceContext,
): Promise<PersonaRow> {
  requireAdminOrSystem(params.actor, "create a persona");
  if (!SLUG_PATTERN.test(params.slug) || params.slug.length > 64) {
    throw new DomainError("invalid", `Invalid persona slug "${params.slug}".`);
  }
  const report = await runPublicationGate(
    {
      kind: "persona_profile",
      body: `${params.bio}\n\n${params.style}`,
      context: { communitySlug: "-", communityName: "-", inheritsTopic: true },
      seed: `persona:${params.slug}:create`,
    },
    { config: ctx.config, validator: ctx.providers.validation },
  );
  if (report.outcome !== "pass") {
    throw new DomainError("gate_quarantined", "Persona profile failed the publication gate.", {
      codes: report.codes,
      slug: params.slug,
    });
  }

  return ctx.db.transaction(async (tx) => {
    const [account] = await tx
      .insert(accounts)
      .values({ username: `bot:${params.slug}`, role: "bot" })
      .returning({ id: accounts.id });
    if (!account) throw new Error("Bot account insert returned no row.");

    const [persona] = await tx
      .insert(personas)
      .values({
        accountId: account.id,
        slug: params.slug,
        displayName: params.displayName.trim(),
        bio: params.bio.trim(),
        interests: params.interests,
        style: params.style.trim(),
        scriptPreference: params.scriptPreference,
        vocabularyNotes: params.vocabularyNotes,
        avatarSeed: params.slug,
        limits: params.limits,
      })
      .returning();
    if (!persona) throw new Error("Persona insert returned no row.");

    await tx.insert(contentRevisions).values({
      targetType: "persona",
      targetId: persona.id,
      revision: 1,
      title: persona.displayName,
      body: `${persona.bio}\n\n${persona.style}`,
      editorKind: params.actor.kind === "admin" ? "admin" : "system",
      editedByAccountId: actorAccountId(params.actor),
    });

    for (const membership of params.memberships) {
      const found = await tx
        .select({ id: communities.id })
        .from(communities)
        .where(eq(communities.slug, membership.communitySlug))
        .limit(1);
      const community = found[0];
      if (!community) {
        throw new DomainError(
          "not_found",
          `Community "${membership.communitySlug}" not found.`,
        );
      }
      await tx.insert(communityMemberships).values({
        personaId: persona.id,
        communityId: community.id,
        affinity: Math.min(5, Math.max(1, Math.round(membership.affinity))),
      });
    }
    return persona;
  });
}

export async function getPersonaBySlug(db: DbOrTx, slug: string): Promise<PersonaRow | null> {
  const rows = await db.select().from(personas).where(eq(personas.slug, slug)).limit(1);
  return rows[0] ?? null;
}

export async function getPersonaById(db: DbOrTx, id: string): Promise<PersonaRow | null> {
  const rows = await db.select().from(personas).where(eq(personas.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listPersonas(db: DbOrTx): Promise<PersonaRow[]> {
  return db.select().from(personas).orderBy(asc(personas.displayName));
}

/** Loads a persona that is allowed to act, or throws the reason it cannot. */
export async function requireActivePersona(db: DbOrTx, personaId: string): Promise<PersonaRow> {
  const persona = await getPersonaById(db, personaId);
  if (!persona) throw new DomainError("not_found", "Persona not found.");
  if (persona.isSuspended) {
    throw new DomainError("forbidden", "Persona is suspended.", {
      personaId,
      reason: persona.suspendedReason,
    });
  }
  return persona;
}

export async function setPersonaSuspended(
  db: DbOrTx,
  params: { actor: Actor; personaId: string; suspended: boolean; reason: string },
  now: Date = new Date(),
): Promise<void> {
  requireAdminOrSystem(params.actor, "suspend a persona");
  await db
    .update(personas)
    .set({
      isSuspended: params.suspended,
      suspendedReason: params.suspended ? params.reason.trim() || null : null,
      updatedAt: now,
    })
    .where(eq(personas.id, params.personaId));
}

/** Appends a memory entry and prunes the persona's memory to the bound. */
export async function rememberParticipation(
  tx: DbOrTx,
  params: {
    personaId: string;
    content: string;
    threadId?: string | null;
    kind?: "view" | "participation" | "note";
  },
  now: Date,
): Promise<void> {
  await tx.insert(personaMemories).values({
    personaId: params.personaId,
    kind: params.kind ?? "participation",
    content: params.content.slice(0, 500),
    threadId: params.threadId ?? null,
    createdAt: now,
    expiresAt: new Date(now.getTime() + MEMORY_TTL_MS),
  });
  await tx
    .delete(personaMemories)
    .where(
      and(eq(personaMemories.personaId, params.personaId), lt(personaMemories.expiresAt, now)),
    );
  const keep = tx
    .select({ id: personaMemories.id })
    .from(personaMemories)
    .where(eq(personaMemories.personaId, params.personaId))
    .orderBy(desc(personaMemories.createdAt))
    .limit(MAX_MEMORIES_PER_PERSONA);
  await tx
    .delete(personaMemories)
    .where(
      and(
        eq(personaMemories.personaId, params.personaId),
        sql`${personaMemories.id} not in (${keep})`,
      ),
    );
}

export async function listPersonaMemories(db: DbOrTx, personaId: string, limit = 20) {
  return db
    .select()
    .from(personaMemories)
    .where(eq(personaMemories.personaId, personaId))
    .orderBy(desc(personaMemories.createdAt))
    .limit(limit);
}
