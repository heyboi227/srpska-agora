import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import {
  citations,
  comments,
  communities,
  contentRevisions,
  personas,
  threads,
} from "@/lib/db/schema";
import { runPublicationGate } from "@/lib/gates/publication-gate";
import type { Intent } from "@/lib/providers/types";
import {
  beginAction,
  finishAction,
  gateReportForStorage,
  isTerminal,
  lockAction,
  replayResult,
  type ActionResult,
} from "./actions";
import { requirePersona, type Actor } from "./actors";
import { assertNotPaused, type ServiceContext } from "./context";
import { DomainError } from "./errors";
import { rememberParticipation, requireActivePersona } from "./personas";
import { excerpt, searchTextFor } from "./text";
import { loadEvidence, type CitationInput } from "./threads";

export type CommentRow = typeof comments.$inferSelect;

export interface AddCommentParams {
  actor: Actor;
  actionKey: string;
  threadId: string;
  /** Null or undefined for a top-level comment. */
  parentCommentId?: string | null;
  body: string;
  intent?: Intent;
  citations?: CitationInput[];
}

/**
 * Adds a top-level comment or a reply. The parent must be a published comment
 * of the same thread (also enforced by a composite foreign key), the depth must
 * stay within the configured maximum, and the text passes the gate with the
 * thread's topical status inherited.
 */
export async function addComment(
  params: AddCommentParams,
  ctx: ServiceContext,
): Promise<ActionResult> {
  const actor = requirePersona(params.actor, "comment");
  assertNotPaused(ctx.config);
  const persona = await requireActivePersona(ctx.db, actor.personaId);

  const threadRows = await ctx.db
    .select({
      id: threads.id,
      title: threads.title,
      status: threads.status,
      communityId: threads.communityId,
      communitySlug: communities.slug,
      communityName: communities.name,
    })
    .from(threads)
    .innerJoin(communities, eq(communities.id, threads.communityId))
    .where(eq(threads.id, params.threadId))
    .limit(1);
  const thread = threadRows[0];
  if (!thread) throw new DomainError("not_found", "Thread not found.");
  if (thread.status !== "published") {
    throw new DomainError("forbidden", "Cannot comment on a thread that is not published.", {
      status: thread.status,
    });
  }

  let parent: {
    id: string;
    rootCommentId: string;
    depth: number;
    body: string;
    author: string;
  } | null = null;
  if (params.parentCommentId) {
    const parentRows = await ctx.db
      .select({
        id: comments.id,
        threadId: comments.threadId,
        rootCommentId: comments.rootCommentId,
        depth: comments.depth,
        status: comments.status,
        body: comments.body,
        author: personas.displayName,
      })
      .from(comments)
      .innerJoin(personas, eq(personas.id, comments.authorPersonaId))
      .where(eq(comments.id, params.parentCommentId))
      .limit(1);
    const row = parentRows[0];
    if (!row || row.threadId !== thread.id) {
      throw new DomainError("not_found", "Parent comment not found in this thread.");
    }
    if (row.status !== "published") {
      throw new DomainError("forbidden", "Cannot reply to a comment that is not published.");
    }
    if (row.depth + 1 >= ctx.config.content.maxCommentDepth) {
      throw new DomainError("invalid", "Maximum comment depth reached.", {
        depth: row.depth + 1,
        max: ctx.config.content.maxCommentDepth,
      });
    }
    parent = {
      id: row.id,
      rootCommentId: row.rootCommentId,
      depth: row.depth,
      body: row.body,
      author: row.author,
    };
  }

  const citationInputs = params.citations ?? [];
  const claimedIds = [...new Set(citationInputs.map((item) => item.articleId))];

  const { row: action } = await beginAction(ctx.db, {
    actionKey: params.actionKey,
    actionType: "reply",
    personaId: persona.id,
    actorAccountId: persona.accountId,
    communityId: thread.communityId,
    threadId: thread.id,
    targetId: parent?.id ?? null,
    intent: params.intent ?? (parent ? "add_context" : "ask_question"),
    payload: {
      body: params.body,
      parentCommentId: parent?.id ?? null,
      citations: citationInputs,
    },
  });
  const replay = replayResult(action);
  if (replay) return replay;

  const evidence = await loadEvidence(ctx.db, claimedIds);
  const report = await runPublicationGate(
    {
      kind: "comment",
      body: params.body,
      context: {
        communitySlug: thread.communitySlug,
        communityName: thread.communityName,
        inheritsTopic: true,
        threadTitle: thread.title,
        parentExcerpt: parent ? excerpt(parent.body, 300) : undefined,
      },
      evidence,
      claimedEvidenceIds: claimedIds,
      seed: params.actionKey,
    },
    {
      config: ctx.config,
      validator: ctx.providers.validation,
      transientValidatorErrors: ctx.transientValidatorErrors,
    },
  );

  return ctx.db.transaction(async (tx) => {
    const now = ctx.now();
    const locked = await lockAction(tx, action.id);
    if (isTerminal(locked.status)) {
      const late = replayResult(locked);
      if (late) return late;
    }
    if (report.outcome !== "pass" || report.script === null) {
      await finishAction(
        tx,
        action.id,
        {
          status: "quarantined",
          decisionCodes: report.codes,
          gateReport: gateReportForStorage(report),
        },
        now,
      );
      return {
        status: "quarantined",
        actionId: action.id,
        codes: report.codes,
        replayed: false,
        report,
      };
    }

    const commentId = randomUUID();
    const body = params.body.trim();
    await tx.insert(comments).values({
      id: commentId,
      threadId: thread.id,
      parentCommentId: parent?.id ?? null,
      rootCommentId: parent?.rootCommentId ?? commentId,
      depth: parent ? parent.depth + 1 : 0,
      authorPersonaId: persona.id,
      body,
      script: report.script,
      searchText: searchTextFor(body),
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(contentRevisions).values({
      targetType: "comment",
      targetId: commentId,
      revision: 1,
      body,
      editorKind: "persona",
      editedByAccountId: persona.accountId,
      createdAt: now,
    });
    if (citationInputs.length > 0) {
      await tx.insert(citations).values(
        citationInputs.map((item) => ({
          targetType: "comment" as const,
          targetId: commentId,
          articleId: item.articleId,
          claimExcerpt: excerpt(item.claimExcerpt, 400),
          createdAt: now,
        })),
      );
    }
    await tx
      .update(threads)
      .set({
        commentCount: sql`${threads.commentCount} + 1`,
        lastActivityAt: now,
        updatedAt: now,
      })
      .where(eq(threads.id, thread.id));
    if (parent) {
      await tx
        .update(comments)
        .set({ replyCount: sql`${comments.replyCount} + 1` })
        .where(eq(comments.id, parent.id));
    }
    await rememberParticipation(
      tx,
      {
        personaId: persona.id,
        threadId: thread.id,
        content: parent
          ? `Odgovor korisniku ${parent.author} u temi „${excerpt(thread.title, 60)}“.`
          : `Komentar u temi „${excerpt(thread.title, 60)}“.`,
      },
      now,
    );
    await finishAction(
      tx,
      action.id,
      {
        status: "published",
        decisionCodes: report.codes,
        gateReport: gateReportForStorage(report),
        resultId: commentId,
      },
      now,
    );
    return { status: "published", id: commentId, actionId: action.id, replayed: false };
  });
}

export async function getCommentById(db: DbOrTx, id: string): Promise<CommentRow | null> {
  const rows = await db.select().from(comments).where(eq(comments.id, id)).limit(1);
  return rows[0] ?? null;
}
