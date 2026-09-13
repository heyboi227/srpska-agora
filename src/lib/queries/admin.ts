import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import {
  agentActions,
  comments,
  communities,
  moderationDecisions,
  personas,
  threads,
  workerHeartbeats,
} from "@/lib/db/schema";

export interface DashboardCounts {
  threadsPublished: number;
  threadsHidden: number;
  commentsPublished: number;
  commentsHidden: number;
  personas: number;
  personasSuspended: number;
  communities: number;
  quarantined: number;
  actionsLast24h: number;
}

export async function getDashboardCounts(db: DbOrTx): Promise<DashboardCounts> {
  const rows = await db.execute<Record<string, number>>(sql`
    select
      (select count(*)::int from ${threads} where ${threads.status} = 'published') as threads_published,
      (select count(*)::int from ${threads} where ${threads.status} = 'hidden') as threads_hidden,
      (select count(*)::int from ${comments} where ${comments.status} = 'published') as comments_published,
      (select count(*)::int from ${comments} where ${comments.status} = 'hidden') as comments_hidden,
      (select count(*)::int from ${personas}) as personas,
      (select count(*)::int from ${personas} where ${personas.isSuspended}) as personas_suspended,
      (select count(*)::int from ${communities} where ${communities.isActive}) as communities,
      (select count(*)::int from ${agentActions} where ${agentActions.status} = 'quarantined') as quarantined,
      (select count(*)::int from ${agentActions} where ${agentActions.createdAt} > now() - interval '24 hours') as actions_last_24h
  `);
  const row = (rows.rows[0] ?? {}) as Record<string, number>;
  return {
    threadsPublished: row.threads_published ?? 0,
    threadsHidden: row.threads_hidden ?? 0,
    commentsPublished: row.comments_published ?? 0,
    commentsHidden: row.comments_hidden ?? 0,
    personas: row.personas ?? 0,
    personasSuspended: row.personas_suspended ?? 0,
    communities: row.communities ?? 0,
    quarantined: row.quarantined ?? 0,
    actionsLast24h: row.actions_last_24h ?? 0,
  };
}

export interface ActionListItem {
  id: string;
  actionKey: string;
  actionType: string;
  status: string;
  intent: string | null;
  personaName: string | null;
  personaSlug: string | null;
  communitySlug: string | null;
  threadId: string | null;
  resultId: string | null;
  decisionCodes: string[];
  attempt: number;
  error: string | null;
  createdAt: Date;
  completedAt: Date | null;
  payload: Record<string, unknown>;
  gateReport: Record<string, unknown> | null;
}

function actionColumns() {
  return {
    id: agentActions.id,
    actionKey: agentActions.actionKey,
    actionType: agentActions.actionType,
    status: agentActions.status,
    intent: agentActions.intent,
    personaName: personas.displayName,
    personaSlug: personas.slug,
    communitySlug: communities.slug,
    threadId: agentActions.threadId,
    resultId: agentActions.resultId,
    decisionCodes: agentActions.decisionCodes,
    attempt: agentActions.attempt,
    error: agentActions.error,
    createdAt: agentActions.createdAt,
    completedAt: agentActions.completedAt,
    payload: agentActions.payload,
    gateReport: agentActions.gateReport,
  };
}

export async function listRecentActions(db: DbOrTx, limit = 30): Promise<ActionListItem[]> {
  return db
    .select(actionColumns())
    .from(agentActions)
    .leftJoin(personas, eq(personas.id, agentActions.personaId))
    .leftJoin(communities, eq(communities.id, agentActions.communityId))
    .orderBy(desc(agentActions.createdAt))
    .limit(limit);
}

export async function listQuarantinedActions(
  db: DbOrTx,
  limit = 50,
): Promise<ActionListItem[]> {
  return db
    .select(actionColumns())
    .from(agentActions)
    .leftJoin(personas, eq(personas.id, agentActions.personaId))
    .leftJoin(communities, eq(communities.id, agentActions.communityId))
    .where(eq(agentActions.status, "quarantined"))
    .orderBy(desc(agentActions.createdAt))
    .limit(limit);
}

export async function getActionById(db: DbOrTx, id: string): Promise<ActionListItem | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const rows = await db
    .select(actionColumns())
    .from(agentActions)
    .leftJoin(personas, eq(personas.id, agentActions.personaId))
    .leftJoin(communities, eq(communities.id, agentActions.communityId))
    .where(eq(agentActions.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export interface HiddenItem {
  targetType: "thread" | "comment";
  id: string;
  threadId: string;
  title: string;
  excerpt: string;
  authorName: string;
  hiddenAt: Date | null;
  explanation: string | null;
}

export async function listHiddenContent(db: DbOrTx, limit = 50): Promise<HiddenItem[]> {
  const hiddenThreads = await db
    .select({
      id: threads.id,
      title: threads.title,
      excerpt: sql<string>`left(${threads.body}, 160)`,
      authorName: personas.displayName,
      hiddenAt: threads.hiddenAt,
    })
    .from(threads)
    .innerJoin(personas, eq(personas.id, threads.authorPersonaId))
    .where(eq(threads.status, "hidden"))
    .orderBy(desc(threads.hiddenAt))
    .limit(limit);
  const hiddenComments = await db
    .select({
      id: comments.id,
      threadId: comments.threadId,
      title: threads.title,
      excerpt: sql<string>`left(${comments.body}, 160)`,
      authorName: personas.displayName,
      hiddenAt: comments.hiddenAt,
    })
    .from(comments)
    .innerJoin(threads, eq(threads.id, comments.threadId))
    .innerJoin(personas, eq(personas.id, comments.authorPersonaId))
    .where(eq(comments.status, "hidden"))
    .orderBy(desc(comments.hiddenAt))
    .limit(limit);

  const items: HiddenItem[] = [
    ...hiddenThreads.map((row) => ({
      targetType: "thread" as const,
      threadId: row.id,
      explanation: null,
      ...row,
    })),
    ...hiddenComments.map((row) => ({
      targetType: "comment" as const,
      explanation: null,
      ...row,
    })),
  ];
  const ids = items.map((item) => item.id);
  if (ids.length > 0) {
    const decisions = await db
      .select({
        targetId: moderationDecisions.targetId,
        explanation: moderationDecisions.explanation,
      })
      .from(moderationDecisions)
      .where(
        and(inArray(moderationDecisions.targetId, ids), eq(moderationDecisions.action, "hide")),
      )
      .orderBy(desc(moderationDecisions.createdAt));
    const byTarget = new Map<string, string>();
    for (const decision of decisions) {
      if (!byTarget.has(decision.targetId))
        byTarget.set(decision.targetId, decision.explanation);
    }
    for (const item of items) item.explanation = byTarget.get(item.id) ?? null;
  }
  items.sort((a, b) => (b.hiddenAt?.getTime() ?? 0) - (a.hiddenAt?.getTime() ?? 0));
  return items;
}

/** A worker is considered gone when its heartbeat is older than this. */
export const WORKER_STALE_MS = 120_000;

export async function listWorkerHeartbeats(db: DbOrTx, now: Date = new Date()) {
  const rows = await db
    .select()
    .from(workerHeartbeats)
    .orderBy(desc(workerHeartbeats.lastSeenAt))
    .limit(10);
  return rows.map((row) => ({
    ...row,
    stale: now.getTime() - row.lastSeenAt.getTime() > WORKER_STALE_MS,
  }));
}
