import { and, asc, eq } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import { communities, contentRevisions } from "@/lib/db/schema";
import { runPublicationGate } from "@/lib/gates/publication-gate";
import { actorAccountId, requireAdminOrSystem, type Actor } from "./actors";
import type { ServiceContext } from "./context";
import { DomainError } from "./errors";

export type CommunityRow = typeof communities.$inferSelect;

export interface CreateCommunityParams {
  actor: Actor;
  slug: string;
  name: string;
  description: string;
  rules: string;
  sortOrder?: number;
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function createCommunity(
  params: CreateCommunityParams,
  ctx: ServiceContext,
): Promise<CommunityRow> {
  requireAdminOrSystem(params.actor, "create a community");
  if (!SLUG_PATTERN.test(params.slug) || params.slug.length > 64) {
    throw new DomainError("invalid", `Invalid community slug "${params.slug}".`);
  }
  const report = await runPublicationGate(
    {
      kind: "community_description",
      body: `${params.description}\n\n${params.rules}`,
      context: { communitySlug: params.slug, communityName: params.name, inheritsTopic: true },
      seed: `community:${params.slug}:create`,
    },
    { config: ctx.config, validator: ctx.providers.validation },
  );
  if (report.outcome !== "pass") {
    throw new DomainError(
      "gate_quarantined",
      "Community description failed the publication gate.",
      {
        codes: report.codes,
      },
    );
  }

  return ctx.db.transaction(async (tx) => {
    const [community] = await tx
      .insert(communities)
      .values({
        slug: params.slug,
        name: params.name.trim(),
        description: params.description.trim(),
        rules: params.rules.trim(),
        sortOrder: params.sortOrder ?? 0,
        createdByAccountId: actorAccountId(params.actor),
      })
      .returning();
    if (!community) throw new Error("Community insert returned no row.");
    await tx.insert(contentRevisions).values({
      targetType: "community",
      targetId: community.id,
      revision: 1,
      title: community.name,
      body: `${community.description}\n\n${community.rules}`,
      editorKind: params.actor.kind === "admin" ? "admin" : "system",
      editedByAccountId: actorAccountId(params.actor),
    });
    return community;
  });
}

export interface UpdateCommunityParams {
  actor: Actor;
  communityId: string;
  description: string;
  rules: string;
  expectedRevision: number;
  reason: string;
  editorKind?: "admin" | "curator" | "system";
}

/** Description and rules edits: gated, versioned, and guarded against stale writers. */
export async function updateCommunityDescription(
  params: UpdateCommunityParams,
  ctx: ServiceContext,
): Promise<CommunityRow> {
  requireAdminOrSystem(params.actor, "edit a community description");
  const current = await getCommunityById(ctx.db, params.communityId);
  if (!current) throw new DomainError("not_found", "Community not found.");

  const report = await runPublicationGate(
    {
      kind: "community_description",
      body: `${params.description}\n\n${params.rules}`,
      notes: [params.reason],
      context: {
        communitySlug: current.slug,
        communityName: current.name,
        inheritsTopic: true,
      },
      seed: `community:${current.slug}:rev:${params.expectedRevision + 1}`,
    },
    { config: ctx.config, validator: ctx.providers.validation },
  );
  if (report.outcome !== "pass") {
    throw new DomainError(
      "gate_quarantined",
      "Community description failed the publication gate.",
      {
        codes: report.codes,
      },
    );
  }

  return ctx.db.transaction(async (tx) => {
    const now = ctx.now();
    const updated = await tx
      .update(communities)
      .set({
        description: params.description.trim(),
        rules: params.rules.trim(),
        revision: params.expectedRevision + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(communities.id, params.communityId),
          eq(communities.revision, params.expectedRevision),
        ),
      )
      .returning();
    const row = updated[0];
    if (!row) {
      throw new DomainError(
        "conflict",
        "Community was modified by someone else; reload and retry.",
        {
          expectedRevision: params.expectedRevision,
        },
      );
    }
    await tx.insert(contentRevisions).values({
      targetType: "community",
      targetId: row.id,
      revision: row.revision,
      title: row.name,
      body: `${row.description}\n\n${row.rules}`,
      editorKind: params.editorKind ?? (params.actor.kind === "admin" ? "admin" : "system"),
      editedByAccountId: actorAccountId(params.actor),
      reason: params.reason.trim(),
      createdAt: now,
    });
    return row;
  });
}

export async function getCommunityBySlug(
  db: DbOrTx,
  slug: string,
): Promise<CommunityRow | null> {
  const rows = await db.select().from(communities).where(eq(communities.slug, slug)).limit(1);
  return rows[0] ?? null;
}

export async function getCommunityById(db: DbOrTx, id: string): Promise<CommunityRow | null> {
  const rows = await db.select().from(communities).where(eq(communities.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listCommunities(db: DbOrTx, options: { includeInactive?: boolean } = {}) {
  const query = db
    .select()
    .from(communities)
    .orderBy(asc(communities.sortOrder), asc(communities.name));
  if (options.includeInactive) return query;
  return query.where(eq(communities.isActive, true));
}
