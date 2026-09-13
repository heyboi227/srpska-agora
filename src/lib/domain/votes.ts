import { and, eq, sql } from "drizzle-orm";
import { comments, threads, votes } from "@/lib/db/schema";
import { requirePersona, type Actor } from "./actors";
import { assertNotPaused, type ServiceContext } from "./context";
import { DomainError, isUniqueViolation } from "./errors";
import { requireActivePersona } from "./personas";

export interface CastVoteParams {
  actor: Actor;
  targetType: "thread" | "comment";
  targetId: string;
  value: 1 | -1;
}

export interface CastVoteResult {
  applied: "created" | "changed" | "unchanged";
  score: number;
}

/** A vote may flip only after this long; rapid toggling is not a real opinion change. */
export const VOTE_TOGGLE_MIN_MS = 60 * 60 * 1000;

/**
 * One current vote per persona per target, no self-votes, no rapid toggling.
 * Score counters change in the same transaction as the vote row, and a
 * duplicate execution finds the existing row and changes nothing.
 */
export async function castVote(
  params: CastVoteParams,
  ctx: ServiceContext,
): Promise<CastVoteResult> {
  const actor = requirePersona(params.actor, "vote");
  assertNotPaused(ctx.config);
  const persona = await requireActivePersona(ctx.db, actor.personaId);
  if (params.value !== 1 && params.value !== -1) {
    throw new DomainError("invalid", "Vote value must be 1 or -1.");
  }

  return ctx.db.transaction(async (tx) => {
    const now = ctx.now();
    const target = await loadTarget(tx, params.targetType, params.targetId);
    if (!target) throw new DomainError("not_found", "Vote target not found.");
    if (target.status !== "published") {
      throw new DomainError("forbidden", "Cannot vote on content that is not published.");
    }
    if (target.authorPersonaId === persona.id) {
      throw new DomainError("forbidden", "A persona cannot vote on its own content.", {
        code: "self_vote",
      });
    }

    let existing = (
      await tx
        .select()
        .from(votes)
        .where(
          and(
            eq(votes.voterPersonaId, persona.id),
            eq(votes.targetType, params.targetType),
            eq(votes.targetId, params.targetId),
          ),
        )
        .for("update")
    )[0];

    if (!existing) {
      try {
        await tx.insert(votes).values({
          voterPersonaId: persona.id,
          targetType: params.targetType,
          targetId: params.targetId,
          threadId: target.threadId,
          value: params.value,
          createdAt: now,
          updatedAt: now,
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // A concurrent duplicate won the race; treat this execution as a no-op.
        existing = (
          await tx
            .select()
            .from(votes)
            .where(
              and(
                eq(votes.voterPersonaId, persona.id),
                eq(votes.targetType, params.targetType),
                eq(votes.targetId, params.targetId),
              ),
            )
        )[0];
        return { applied: "unchanged", score: target.score };
      }
      const score = await applyDelta(
        tx,
        params.targetType,
        params.targetId,
        params.value,
        null,
        now,
      );
      return { applied: "created", score };
    }

    if (existing.value === params.value) {
      return { applied: "unchanged", score: target.score };
    }
    if (now.getTime() - existing.updatedAt.getTime() < VOTE_TOGGLE_MIN_MS) {
      throw new DomainError("limit_reached", "Vote changed too recently.", {
        code: "vote_toggle_too_fast",
        retryAfter: new Date(existing.updatedAt.getTime() + VOTE_TOGGLE_MIN_MS),
      });
    }
    await tx
      .update(votes)
      .set({ value: params.value, updatedAt: now })
      .where(eq(votes.id, existing.id));
    const score = await applyDelta(
      tx,
      params.targetType,
      params.targetId,
      params.value,
      existing.value,
      now,
    );
    return { applied: "changed", score };
  });
}

type Target = { threadId: string; authorPersonaId: string; status: string; score: number };

async function loadTarget(
  tx: Parameters<Parameters<ServiceContext["db"]["transaction"]>[0]>[0],
  targetType: "thread" | "comment",
  targetId: string,
): Promise<Target | null> {
  if (targetType === "thread") {
    const rows = await tx
      .select({
        threadId: threads.id,
        authorPersonaId: threads.authorPersonaId,
        status: threads.status,
        score: threads.score,
      })
      .from(threads)
      .where(eq(threads.id, targetId))
      .limit(1);
    return rows[0] ?? null;
  }
  const rows = await tx
    .select({
      threadId: comments.threadId,
      authorPersonaId: comments.authorPersonaId,
      status: comments.status,
      score: comments.score,
    })
    .from(comments)
    .where(eq(comments.id, targetId))
    .limit(1);
  return rows[0] ?? null;
}

async function applyDelta(
  tx: Parameters<Parameters<ServiceContext["db"]["transaction"]>[0]>[0],
  targetType: "thread" | "comment",
  targetId: string,
  value: 1 | -1,
  previous: number | null,
  now: Date,
): Promise<number> {
  const upDelta = (value === 1 ? 1 : 0) - (previous === 1 ? 1 : 0);
  const downDelta = (value === -1 ? 1 : 0) - (previous === -1 ? 1 : 0);
  const scoreDelta = value - (previous ?? 0);
  if (targetType === "thread") {
    const [row] = await tx
      .update(threads)
      .set({
        upvotes: sql`${threads.upvotes} + ${upDelta}`,
        downvotes: sql`${threads.downvotes} + ${downDelta}`,
        score: sql`${threads.score} + ${scoreDelta}`,
        lastActivityAt: now,
      })
      .where(eq(threads.id, targetId))
      .returning({ score: threads.score });
    return row?.score ?? 0;
  }
  const [row] = await tx
    .update(comments)
    .set({
      upvotes: sql`${comments.upvotes} + ${upDelta}`,
      downvotes: sql`${comments.downvotes} + ${downDelta}`,
      score: sql`${comments.score} + ${scoreDelta}`,
    })
    .where(eq(comments.id, targetId))
    .returning({ score: comments.score });
  return row?.score ?? 0;
}
