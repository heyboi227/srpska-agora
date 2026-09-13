import { randomUUID } from "node:crypto";
import { eq, inArray, isNotNull, sql } from "drizzle-orm";
import { agentActions, threads } from "@/lib/db/schema";
import { actorAccountId, requireAdminOrSystem, type Actor } from "./actors";
import type { ServiceContext } from "./context";
import { DomainError } from "./errors";

/**
 * Bounded curation: pinning and the "U fokusu" list. These change what readers
 * see first, so they are audited as actions. Phase 4 adds rotation rules; the
 * operations themselves are already the only way to change these fields.
 */

export async function setThreadPinned(
  params: { actor: Actor; threadId: string; pinned: boolean; reason?: string },
  ctx: ServiceContext,
): Promise<void> {
  requireAdminOrSystem(params.actor, "pin a thread");
  await ctx.db.transaction(async (tx) => {
    const now = ctx.now();
    const updated = await tx
      .update(threads)
      .set({ isPinned: params.pinned, pinnedAt: params.pinned ? now : null, updatedAt: now })
      .where(eq(threads.id, params.threadId))
      .returning({ id: threads.id, communityId: threads.communityId });
    const row = updated[0];
    if (!row) throw new DomainError("not_found", "Thread not found.");
    await tx.insert(agentActions).values({
      // Curation audit rows are not retried jobs, so the key only needs to be unique.
      actionKey: `curate:pin:${params.threadId}:${now.getTime()}:${randomUUID().slice(0, 8)}`,
      actionType: "curate",
      status: "published",
      actorAccountId: actorAccountId(params.actor),
      communityId: row.communityId,
      threadId: params.threadId,
      targetId: params.threadId,
      intent: params.pinned ? "pin" : "unpin",
      payload: { pinned: params.pinned, reason: params.reason ?? "" },
      resultId: params.threadId,
      createdAt: now,
      completedAt: now,
    });
  });
}

/**
 * Replaces the featured list. Order is rank; the list is capped by
 * news.maxFeaturedStories; only published threads qualify.
 */
export async function setFeaturedThreads(
  params: { actor: Actor; threadIds: string[]; featuredUntil?: Date | null; reason?: string },
  ctx: ServiceContext,
): Promise<void> {
  requireAdminOrSystem(params.actor, "change the featured list");
  const unique = [...new Set(params.threadIds)];
  if (unique.length > ctx.config.news.maxFeaturedStories) {
    throw new DomainError("limit_reached", "Too many featured threads.", {
      max: ctx.config.news.maxFeaturedStories,
      requested: unique.length,
    });
  }
  await ctx.db.transaction(async (tx) => {
    const now = ctx.now();
    if (unique.length > 0) {
      const published = await tx
        .select({ id: threads.id })
        .from(threads)
        .where(inArray(threads.id, unique));
      const found = new Set(published.map((row) => row.id));
      const missing = unique.filter((id) => !found.has(id));
      if (missing.length > 0) {
        throw new DomainError("not_found", "Some threads do not exist.", { missing });
      }
    }
    await tx
      .update(threads)
      .set({ featuredRank: null, featuredUntil: null, updatedAt: now })
      .where(isNotNull(threads.featuredRank));
    for (const [index, id] of unique.entries()) {
      await tx
        .update(threads)
        .set({
          featuredRank: index + 1,
          featuredUntil: params.featuredUntil ?? null,
          updatedAt: now,
        })
        .where(sql`${threads.id} = ${id} and ${threads.status} = 'published'`);
    }
    await tx.insert(agentActions).values({
      actionKey: `curate:featured:${now.getTime()}:${randomUUID().slice(0, 8)}`,
      actionType: "curate",
      status: "published",
      actorAccountId: actorAccountId(params.actor),
      intent: "featured",
      payload: {
        threadIds: unique,
        featuredUntil: params.featuredUntil?.toISOString() ?? null,
        reason: params.reason ?? "",
      },
      createdAt: now,
      completedAt: now,
    });
  });
}
