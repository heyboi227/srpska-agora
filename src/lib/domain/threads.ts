import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import {
  articles,
  citations,
  communities,
  contentRevisions,
  sources,
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
import { getCommunityBySlug } from "./communities";
import { assertNotPaused, type ServiceContext } from "./context";
import { DomainError } from "./errors";
import { rememberParticipation, requireActivePersona } from "./personas";
import { excerpt, searchTextFor } from "./text";

export type ThreadRow = typeof threads.$inferSelect;

export interface CitationInput {
  articleId: string;
  claimExcerpt: string;
}

export interface CreateThreadParams {
  actor: Actor;
  /** Stable idempotency key, e.g. "seed:thread:kuhinja-ajvar" or a scheduler action id. */
  actionKey: string;
  communitySlug: string;
  title: string;
  body: string;
  tags?: string[];
  intent?: Intent;
  citations?: CitationInput[];
}

/** Loads the articles a caller cites so the gate can verify the claimed ids. */
export async function loadEvidence(db: DbOrTx, articleIds: string[]) {
  if (articleIds.length === 0) return [];
  const rows = await db
    .select({
      id: articles.id,
      title: articles.title,
      summary: articles.summary,
      publisher: sources.publisherName,
    })
    .from(articles)
    .innerJoin(sources, eq(sources.id, articles.sourceId))
    .where(inArray(articles.id, articleIds));
  return rows;
}

/**
 * Creates a thread through the full pipeline: permission, pause state, action
 * record, publication gate, transactional publish with citations, memory and
 * counters. Returns the recorded result on replay.
 */
export async function createThread(
  params: CreateThreadParams,
  ctx: ServiceContext,
): Promise<ActionResult> {
  const actor = requirePersona(params.actor, "create a thread");
  assertNotPaused(ctx.config);
  const persona = await requireActivePersona(ctx.db, actor.personaId);
  const community = await getCommunityBySlug(ctx.db, params.communitySlug);
  if (!community || !community.isActive) {
    throw new DomainError(
      "not_found",
      `Community "${params.communitySlug}" not found or inactive.`,
    );
  }

  const tags = normalizeTags(params.tags ?? []);
  const citationInputs = params.citations ?? [];
  const claimedIds = [...new Set(citationInputs.map((item) => item.articleId))];

  const { row: action } = await beginAction(ctx.db, {
    actionKey: params.actionKey,
    actionType: "create_thread",
    personaId: persona.id,
    actorAccountId: persona.accountId,
    communityId: community.id,
    intent: params.intent ?? "introduce_topic",
    payload: { title: params.title, body: params.body, tags, citations: citationInputs },
  });
  const replay = replayResult(action);
  if (replay) return replay;

  const evidence = await loadEvidence(ctx.db, claimedIds);
  const report = await runPublicationGate(
    {
      kind: "thread",
      title: params.title,
      body: params.body,
      context: {
        communitySlug: community.slug,
        communityName: community.name,
        inheritsTopic: false,
      },
      evidence,
      claimedEvidenceIds: claimedIds,
      seed: params.actionKey,
    },
    { config: ctx.config, validator: ctx.providers.validation },
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

    const threadId = randomUUID();
    const title = params.title.trim();
    const body = params.body.trim();
    await tx.insert(threads).values({
      id: threadId,
      communityId: community.id,
      authorPersonaId: persona.id,
      title,
      body,
      script: report.script,
      tags,
      searchText: searchTextFor(title, body),
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(contentRevisions).values({
      targetType: "thread",
      targetId: threadId,
      revision: 1,
      title,
      body,
      editorKind: "persona",
      editedByAccountId: persona.accountId,
      createdAt: now,
    });
    if (citationInputs.length > 0) {
      await tx.insert(citations).values(
        citationInputs.map((item) => ({
          targetType: "thread" as const,
          targetId: threadId,
          articleId: item.articleId,
          claimExcerpt: excerpt(item.claimExcerpt, 400),
          createdAt: now,
        })),
      );
    }
    await tx
      .update(communities)
      .set({ threadCount: sql`${communities.threadCount} + 1`, updatedAt: now })
      .where(eq(communities.id, community.id));
    await rememberParticipation(
      tx,
      {
        personaId: persona.id,
        threadId,
        content: `Nova tema „${excerpt(title, 80)}“ u zajednici ${community.name}.`,
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
        resultId: threadId,
        threadId,
      },
      now,
    );
    return { status: "published", id: threadId, actionId: action.id, replayed: false };
  });
}

export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 32);
    if (tag.length === 0 || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length === 8) break;
  }
  return out;
}

export async function getThreadById(db: DbOrTx, id: string): Promise<ThreadRow | null> {
  const rows = await db.select().from(threads).where(eq(threads.id, id)).limit(1);
  return rows[0] ?? null;
}
