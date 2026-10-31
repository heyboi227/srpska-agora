import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull, max } from "drizzle-orm";
import { clip } from "@/lib/context/budget";
import { loadThreadFacts } from "@/lib/context/facts";
import { CONTEXT_LIMITS } from "@/lib/context/limits";
import type { DbOrTx } from "@/lib/db/client";
import {
  agentActions,
  comments,
  communities,
  personas,
  threads,
  threadSummaries,
} from "@/lib/db/schema";
import { runPublicationGate } from "@/lib/gates/publication-gate";
import type { PersonaBrief } from "@/lib/providers/types";
import {
  beginAction,
  finishAction,
  gateReportForStorage,
  isTerminal,
  lockAction,
  replayResult,
  type ActionResult,
} from "./actions";
import { assertNotPaused, type ServiceContext } from "./context";
import { DomainError } from "./errors";

export const SUMMARY_MAX_CHARACTERS = 1500;
/** Newest comments handed to the summariser when a lot has been said since the last summary. */
const SUMMARY_COMMENT_WINDOW = 30;
const SUMMARY_COMMENT_CHARS = 300;

/** The voice of every summary: system-authored, never attributed to a persona. */
export const SUMMARY_PERSONA: PersonaBrief = {
  id: "system-summary",
  slug: "sazetak",
  displayName: "Sažetak rasprave",
  style: "Neutralan i sažet; navodi izvore i ono što je nesigurno.",
  vocabularyNotes: "Ekavica, neutralan registar.",
  interests: [],
  scriptPreference: "Latin",
};

export interface SummarizeThreadParams {
  actionKey: string;
  threadId: string;
  /** Skips the "due" check, e.g. for the seed. */
  force?: boolean;
}

export type ThreadSummaryRow = typeof threadSummaries.$inferSelect;

export async function getLatestSummary(
  db: DbOrTx,
  threadId: string,
): Promise<ThreadSummaryRow | null> {
  const rows = await db
    .select()
    .from(threadSummaries)
    .where(and(eq(threadSummaries.threadId, threadId), isNull(threadSummaries.invalidatedAt)))
    .orderBy(desc(threadSummaries.revision))
    .limit(1);
  return rows[0] ?? null;
}

/** Revisions number from the maximum over all rows, invalidated ones included, so (thread, revision) stays unique. */
async function nextSummaryRevision(db: DbOrTx, threadId: string): Promise<number> {
  const [row] = await db
    .select({ max: max(threadSummaries.revision) })
    .from(threadSummaries)
    .where(eq(threadSummaries.threadId, threadId));
  return (row?.max ?? 0) + 1;
}

/** A summary is due once `everyComments` comments have arrived since the last one. */
export async function isSummaryDue(
  db: DbOrTx,
  threadId: string,
  everyComments: number,
): Promise<{ due: boolean; newComments: number; coveredCount: number }> {
  const rows = await db
    .select({ commentCount: threads.commentCount })
    .from(threads)
    .where(eq(threads.id, threadId))
    .limit(1);
  if (!rows[0]) throw new DomainError("not_found", "Thread not found.");
  const latest = await getLatestSummary(db, threadId);
  const coveredCount = latest?.coversCommentCount ?? 0;
  const newComments = rows[0].commentCount - coveredCount;
  return { due: newComments >= everyComments, newComments, coveredCount };
}

/**
 * Writes the next rolling summary of a thread: system-authored, passed through
 * the "summary" gate, stored with its history and the articles it relies on.
 */
export async function summarizeThread(
  params: SummarizeThreadParams,
  ctx: ServiceContext,
): Promise<ActionResult> {
  assertNotPaused(ctx.config);

  // A retried key returns the earlier outcome even though the summary is no longer due.
  const earlier = await ctx.db
    .select()
    .from(agentActions)
    .where(eq(agentActions.actionKey, params.actionKey))
    .limit(1);
  if (earlier[0] && isTerminal(earlier[0].status)) {
    const replay = replayResult(earlier[0]);
    if (replay) return replay;
  }

  const threadRows = await ctx.db
    .select({
      id: threads.id,
      title: threads.title,
      body: threads.body,
      script: threads.script,
      status: threads.status,
      commentCount: threads.commentCount,
      communityId: threads.communityId,
      communitySlug: communities.slug,
      communityName: communities.name,
      communityDescription: communities.description,
    })
    .from(threads)
    .innerJoin(communities, eq(communities.id, threads.communityId))
    .where(eq(threads.id, params.threadId))
    .limit(1);
  const thread = threadRows[0];
  if (!thread) throw new DomainError("not_found", "Thread not found.");
  if (thread.status !== "published") {
    throw new DomainError("forbidden", "Cannot summarise a thread that is not published.", {
      status: thread.status,
    });
  }

  const previous = await getLatestSummary(ctx.db, thread.id);
  const coversCommentCount = thread.commentCount;
  if (!params.force) {
    const due = await isSummaryDue(
      ctx.db,
      thread.id,
      ctx.config.scheduler.summaryEveryComments,
    );
    if (!due.due) {
      throw new DomainError("invalid", "Summary not due.", {
        newComments: due.newComments,
        every: ctx.config.scheduler.summaryEveryComments,
      });
    }
  }

  const { row: action } = await beginAction(ctx.db, {
    actionKey: params.actionKey,
    actionType: "summarize",
    personaId: null,
    actorAccountId: null,
    communityId: thread.communityId,
    threadId: thread.id,
    intent: "summarize",
    payload: { coversCommentCount, previousRevision: previous?.revision ?? null },
  });
  const replay = replayResult(action);
  if (replay) return replay;

  // Published comments since the previous summary, newest window, oldest first.
  const since = previous?.lastCommentAt ?? null;
  const recent = await ctx.db
    .select({
      body: comments.body,
      author: personas.displayName,
      createdAt: comments.createdAt,
    })
    .from(comments)
    .innerJoin(personas, eq(personas.id, comments.authorPersonaId))
    .where(
      and(
        eq(comments.threadId, thread.id),
        eq(comments.status, "published"),
        since ? gt(comments.createdAt, since) : undefined,
      ),
    )
    .orderBy(desc(comments.createdAt), desc(comments.id))
    .limit(SUMMARY_COMMENT_WINDOW);
  recent.reverse();
  const lastCommentAt = recent.at(-1)?.createdAt ?? previous?.lastCommentAt ?? null;

  const facts = await loadThreadFacts(
    ctx.db,
    thread.id,
    CONTEXT_LIMITS.facts,
    CONTEXT_LIMITS.factSummaryChars,
  );

  const generateSummary = async () => {
    const generated = await ctx.providers.generation.generate({
      purpose: "summary",
      persona: { ...SUMMARY_PERSONA, scriptPreference: thread.script },
      intent: "summarize",
      context: {
        community: {
          slug: thread.communitySlug,
          name: thread.communityName,
          description: clip(thread.communityDescription, CONTEXT_LIMITS.community),
        },
        threadTitle: thread.title,
        threadBody: clip(thread.body.replace(/s+/g, " ").trim(), CONTEXT_LIMITS.threadBody),
        threadSummary: previous ? clip(previous.body, CONTEXT_LIMITS.summary) : undefined,
        recentComments: recent.map((row) => ({
          author: row.author,
          body: clip(row.body.replace(/\s+/g, " ").trim(), SUMMARY_COMMENT_CHARS),
        })),
        facts,
        memory: [],
      },
      seed: params.actionKey,
      maxOutputTokens: ctx.config.budget.generationMaxBilledOutputTokens,
      maxBodyCharacters: SUMMARY_MAX_CHARACTERS,
    });
    await ctx.db
      .update(agentActions)
      .set({
        payload: {
          ...action.payload,
          body: generated.body,
          evidenceIds: generated.evidenceIds,
        },
      })
      .where(eq(agentActions.id, action.id));
    return generated;
  };

  // A retry after a transient validator failure reuses the draft stored on the proposed row.
  const storedBody = typeof action.payload.body === "string" ? action.payload.body : null;
  const storedEvidence = Array.isArray(action.payload.evidenceIds)
    ? (action.payload.evidenceIds as string[])
    : [];
  const result =
    storedBody && storedBody.length > 0
      ? { body: storedBody, evidenceIds: storedEvidence }
      : await generateSummary();

  const body = result.body.trim();
  const report = await runPublicationGate(
    {
      kind: "summary",
      body,
      context: {
        communitySlug: thread.communitySlug,
        communityName: thread.communityName,
        inheritsTopic: true,
        threadTitle: thread.title,
      },
      evidence: facts.map((fact) => ({
        id: fact.id,
        title: fact.title,
        summary: fact.summary,
      })),
      claimedEvidenceIds: result.evidenceIds,
      seed: params.actionKey,
    },
    {
      config: ctx.config,
      validator: ctx.providers.validation,
      transientValidatorErrors: ctx.transientValidatorErrors,
    },
  );
  const codes = [...report.codes];
  if (body.length > SUMMARY_MAX_CHARACTERS) codes.push("summary_too_long");
  const passed =
    report.outcome === "pass" && report.script !== null && codes.length === report.codes.length;

  return ctx.db.transaction(async (tx) => {
    const now = ctx.now();
    const locked = await lockAction(tx, action.id);
    if (isTerminal(locked.status)) {
      const late = replayResult(locked);
      if (late) return late;
    }
    if (!passed || report.script === null) {
      await finishAction(
        tx,
        action.id,
        {
          status: "quarantined",
          decisionCodes: codes,
          gateReport: gateReportForStorage(report),
        },
        now,
      );
      return { status: "quarantined", actionId: action.id, codes, replayed: false, report };
    }

    const summaryId = randomUUID();
    await tx.insert(threadSummaries).values({
      id: summaryId,
      threadId: thread.id,
      revision: await nextSummaryRevision(tx, thread.id),
      body,
      script: report.script,
      coversCommentCount,
      lastCommentAt,
      sourceArticleIds: [...new Set(result.evidenceIds)],
      actionId: action.id,
      createdAt: now,
    });
    await finishAction(
      tx,
      action.id,
      {
        status: "published",
        decisionCodes: report.codes,
        gateReport: gateReportForStorage(report),
        resultId: summaryId,
      },
      now,
    );
    return { status: "published", id: summaryId, actionId: action.id, replayed: false };
  });
}
