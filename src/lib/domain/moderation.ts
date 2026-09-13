import { and, desc, eq } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import { agentActions, comments, moderationDecisions, threads } from "@/lib/db/schema";
import { runPublicationGate } from "@/lib/gates/publication-gate";
import { actorAccountId, requireAdminOrSystem, type Actor } from "./actors";
import type { ServiceContext } from "./context";
import { DomainError } from "./errors";

export interface ModerateContentParams {
  actor: Actor;
  targetType: "thread" | "comment";
  targetId: string;
  action: "hide" | "restore";
  /** Serbian, public: shown where the content used to be. */
  explanation: string;
}

/**
 * Moderation hides or restores; it never rewrites. The explanation is public
 * prose and passes the gate like any other text. Moderation works while the
 * forum is paused, because pausing exists so the administrator can act.
 */
export async function moderateContent(params: ModerateContentParams, ctx: ServiceContext) {
  requireAdminOrSystem(params.actor, "moderate content");
  const report = await runPublicationGate(
    {
      kind: "moderation_note",
      body: params.explanation,
      context: { communitySlug: "-", communityName: "-", inheritsTopic: true },
      seed: `moderate:${params.targetType}:${params.targetId}:${params.action}`,
    },
    { config: ctx.config, validator: ctx.providers.validation },
  );
  if (report.outcome !== "pass") {
    throw new DomainError(
      "gate_quarantined",
      "Moderation explanation failed the publication gate.",
      {
        codes: report.codes,
      },
    );
  }

  return ctx.db.transaction(async (tx) => {
    const now = ctx.now();
    const nextStatus = params.action === "hide" ? "hidden" : "published";
    const table = params.targetType === "thread" ? threads : comments;
    const current = (
      await tx
        .select({ status: table.status })
        .from(table)
        .where(eq(table.id, params.targetId))
        .limit(1)
    )[0];
    if (!current) throw new DomainError("not_found", "Content not found.");
    if (current.status === "quarantined") {
      throw new DomainError(
        "forbidden",
        "Quarantined drafts are handled in the review queue, not by moderation.",
      );
    }
    if (current.status === nextStatus) {
      throw new DomainError("conflict", `Content is already ${nextStatus}.`);
    }
    if (params.targetType === "thread") {
      await tx
        .update(threads)
        .set({
          status: nextStatus,
          hiddenAt: nextStatus === "hidden" ? now : null,
          updatedAt: now,
        })
        .where(eq(threads.id, params.targetId));
    } else {
      await tx
        .update(comments)
        .set({
          status: nextStatus,
          hiddenAt: nextStatus === "hidden" ? now : null,
          updatedAt: now,
        })
        .where(eq(comments.id, params.targetId));
    }
    const [decision] = await tx
      .insert(moderationDecisions)
      .values({
        targetType: params.targetType,
        targetId: params.targetId,
        action: params.action,
        explanation: params.explanation.trim(),
        actorAccountId: actorAccountId(params.actor),
        createdAt: now,
      })
      .returning();
    return decision;
  });
}

/** The latest moderation decision for a piece of content, for public display. */
export async function latestModerationDecision(
  db: DbOrTx,
  targetType: "thread" | "comment",
  targetId: string,
) {
  const rows = await db
    .select()
    .from(moderationDecisions)
    .where(
      and(
        eq(moderationDecisions.targetType, targetType),
        eq(moderationDecisions.targetId, targetId),
      ),
    )
    .orderBy(desc(moderationDecisions.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Discards a quarantined draft. Releasing a draft that failed the gate is
 * intentionally impossible: nothing publishes without passing.
 */
export async function discardQuarantinedAction(
  params: { actor: Actor; actionId: string; note: string },
  ctx: ServiceContext,
): Promise<void> {
  requireAdminOrSystem(params.actor, "discard a quarantined draft");
  const updated = await ctx.db
    .update(agentActions)
    .set({
      status: "rejected",
      error: params.note.trim().slice(0, 500) || null,
      completedAt: ctx.now(),
    })
    .where(and(eq(agentActions.id, params.actionId), eq(agentActions.status, "quarantined")))
    .returning({ id: agentActions.id });
  if (updated.length === 0) {
    throw new DomainError("not_found", "No quarantined action with that id.");
  }
}
