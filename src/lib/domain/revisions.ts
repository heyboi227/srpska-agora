import { and, asc, eq } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import { comments, communities, contentRevisions, threads } from "@/lib/db/schema";
import { runPublicationGate } from "@/lib/gates/publication-gate";
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

export interface ReviseOwnContentParams {
  actor: Actor;
  actionKey: string;
  targetType: "thread" | "comment";
  targetId: string;
  /** The revision the author last saw; a stale value fails with "conflict". */
  expectedRevision: number;
  title?: string;
  body: string;
  /** Serbian, public: shown in the revision history. */
  reason: string;
}

/**
 * Authors revise their own published contributions. The new text passes the
 * same gate as a first publication, the change is recorded as a new revision,
 * and optimistic concurrency stops a stale job from overwriting a newer fix.
 */
export async function reviseOwnContent(
  params: ReviseOwnContentParams,
  ctx: ServiceContext,
): Promise<ActionResult> {
  const actor = requirePersona(params.actor, "revise content");
  assertNotPaused(ctx.config);
  const persona = await requireActivePersona(ctx.db, actor.personaId);

  const target = await loadTargetForRevision(ctx.db, params.targetType, params.targetId);
  if (!target) throw new DomainError("not_found", "Content not found.");
  if (target.authorPersonaId !== persona.id) {
    throw new DomainError("forbidden", "Only the author may revise this content.");
  }
  if (target.status !== "published") {
    throw new DomainError("forbidden", "Only published content can be revised.", {
      status: target.status,
    });
  }
  if (target.revision !== params.expectedRevision) {
    throw new DomainError(
      "conflict",
      "Content changed since it was loaded; reload and retry.",
      {
        currentRevision: target.revision,
        expectedRevision: params.expectedRevision,
      },
    );
  }
  if (params.reason.trim().length === 0) {
    throw new DomainError("invalid", "A revision needs a public reason.");
  }

  const { row: action } = await beginAction(ctx.db, {
    actionKey: params.actionKey,
    actionType: "revise",
    personaId: persona.id,
    actorAccountId: persona.accountId,
    communityId: target.communityId,
    threadId: target.threadId,
    targetId: params.targetId,
    intent: "correct_earlier",
    payload: {
      targetType: params.targetType,
      expectedRevision: params.expectedRevision,
      title: params.title ?? null,
      body: params.body,
      reason: params.reason,
    },
  });
  const replay = replayResult(action);
  if (replay) return replay;

  const isThread = params.targetType === "thread";
  const report = await runPublicationGate(
    {
      kind: isThread ? "revision_thread" : "revision_comment",
      title: isThread ? (params.title ?? target.title ?? "") : undefined,
      body: params.body,
      notes: [params.reason],
      context: {
        communitySlug: target.communitySlug,
        communityName: target.communityName,
        inheritsTopic: !isThread,
        threadTitle: target.threadTitle,
      },
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

    const nextRevision = params.expectedRevision + 1;
    const body = params.body.trim();
    let updatedCount = 0;
    let storedTitle: string | null = null;
    if (isThread) {
      const title = (params.title ?? target.title ?? "").trim();
      storedTitle = title;
      const updated = await tx
        .update(threads)
        .set({
          title,
          body,
          script: report.script,
          revision: nextRevision,
          searchText: searchTextFor(title, body),
          updatedAt: now,
          lastActivityAt: now,
        })
        .where(
          and(eq(threads.id, params.targetId), eq(threads.revision, params.expectedRevision)),
        )
        .returning({ id: threads.id });
      updatedCount = updated.length;
    } else {
      const updated = await tx
        .update(comments)
        .set({
          body,
          script: report.script,
          revision: nextRevision,
          searchText: searchTextFor(body),
          updatedAt: now,
        })
        .where(
          and(eq(comments.id, params.targetId), eq(comments.revision, params.expectedRevision)),
        )
        .returning({ id: comments.id });
      updatedCount = updated.length;
    }
    if (updatedCount === 0) {
      throw new DomainError(
        "conflict",
        "Content changed during revision; nothing was written.",
        {
          expectedRevision: params.expectedRevision,
        },
      );
    }
    await tx.insert(contentRevisions).values({
      targetType: params.targetType,
      targetId: params.targetId,
      revision: nextRevision,
      title: storedTitle,
      body,
      editorKind: "persona",
      editedByAccountId: persona.accountId,
      reason: params.reason.trim(),
      createdAt: now,
    });
    await rememberParticipation(
      tx,
      {
        personaId: persona.id,
        threadId: target.threadId,
        content: `Ispravka sopstvenog ${isThread ? "teksta teme" : "komentara"}: ${excerpt(params.reason, 80)}`,
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
        resultId: params.targetId,
      },
      now,
    );
    return { status: "published", id: params.targetId, actionId: action.id, replayed: false };
  });
}

interface RevisionTarget {
  authorPersonaId: string;
  status: string;
  revision: number;
  title: string | null;
  threadId: string;
  threadTitle: string;
  communityId: string;
  communitySlug: string;
  communityName: string;
}

async function loadTargetForRevision(
  db: DbOrTx,
  targetType: "thread" | "comment",
  targetId: string,
): Promise<RevisionTarget | null> {
  if (targetType === "thread") {
    const rows = await db
      .select({
        authorPersonaId: threads.authorPersonaId,
        status: threads.status,
        revision: threads.revision,
        title: threads.title,
        threadId: threads.id,
        threadTitle: threads.title,
        communityId: communities.id,
        communitySlug: communities.slug,
        communityName: communities.name,
      })
      .from(threads)
      .innerJoin(communities, eq(communities.id, threads.communityId))
      .where(eq(threads.id, targetId))
      .limit(1);
    return rows[0] ?? null;
  }
  const rows = await db
    .select({
      authorPersonaId: comments.authorPersonaId,
      status: comments.status,
      revision: comments.revision,
      threadId: threads.id,
      threadTitle: threads.title,
      communityId: communities.id,
      communitySlug: communities.slug,
      communityName: communities.name,
    })
    .from(comments)
    .innerJoin(threads, eq(threads.id, comments.threadId))
    .innerJoin(communities, eq(communities.id, threads.communityId))
    .where(eq(comments.id, targetId))
    .limit(1);
  const row = rows[0];
  return row ? { ...row, title: null } : null;
}

export async function listRevisions(
  db: DbOrTx,
  targetType: "thread" | "comment",
  targetId: string,
) {
  return db
    .select()
    .from(contentRevisions)
    .where(
      and(eq(contentRevisions.targetType, targetType), eq(contentRevisions.targetId, targetId)),
    )
    .orderBy(asc(contentRevisions.revision));
}
