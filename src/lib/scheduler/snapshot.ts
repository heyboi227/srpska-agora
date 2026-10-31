import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { AgoraConfig } from "@/lib/config/schema";
import type { DbOrTx } from "@/lib/db/client";
import {
  agentActions,
  comments,
  communityMemberships,
  personas,
  schedulerDecisions,
  threads,
  votes,
} from "@/lib/db/schema";
import type { PersonaLimits } from "@/lib/db/schema/personas";
import type { ActionKind } from "@/lib/jobs/types";
import type { Intent } from "@/lib/providers/types";
import { belgradeDayStart, belgradeHour } from "@/lib/time";
import { emptyCounts, type SlotCounts } from "./pacing";
import { SNAPSHOT_LIMITS } from "./weights";

const HOUR_MS = 3_600_000;
const COUNTED_OUTCOMES = new Set(["queued", "published", "quarantined"]);

export interface PersonaInfo {
  id: string;
  displayName: string;
  interests: string[];
  limits: PersonaLimits;
  isSuspended: boolean;
  /** communityId -> affinity 1..5; membership is the key's presence. */
  affinity: Map<string, number>;
}

export interface PersonaUsage {
  contentToday: number;
  votesToday: number;
  lastContentAt: Date | null;
}

export interface SnapshotThread {
  id: string;
  communityId: string;
  title: string;
  authorPersonaId: string;
  commentCount: number;
  createdAt: Date;
  lastActivityAt: Date;
  revision: number;
  score: number;
  isQuestion: boolean;
  hasFreshEvidence: boolean;
  commentsLast24h: number;
  summaryCovers: number;
}

export interface SnapshotComment {
  id: string;
  threadId: string;
  parentCommentId: string | null;
  authorPersonaId: string;
  depth: number;
  createdAt: Date;
  updatedAt: Date;
  replyCount: number;
  revision: number;
  score: number;
  isQuestion: boolean;
  intent: Intent | null;
}

export interface SnapshotCommunity {
  id: string;
  isActive: boolean;
  newestThreadAt: Date | null;
}

export interface SchedulerSnapshot {
  now: Date;
  hour: number;
  dayStart: Date;
  personas: PersonaInfo[];
  activePersonaCount: number;
  communities: Map<string, SnapshotCommunity>;
  threads: SnapshotThread[];
  threadsById: Map<string, SnapshotThread>;
  comments: SnapshotComment[];
  commentsById: Map<string, SnapshotComment>;
  /** Scheduler decisions counted toward the Belgrade day's maxima. */
  usedToday: SlotCounts;
  /** Everything planned in the last 60 minutes, whatever its outcome. */
  plannedLastHour: SlotCounts;
  usage: Map<string, PersonaUsage>;
  /** `${personaId}:${threadId}` -> contributions today (published comments + queued replies). */
  threadContributions: Map<string, number>;
  /** `${personaId}:${threadId}` -> all published comments by the persona in the thread. */
  personaThreadComments: Map<string, number>;
  /** `${A}:${B}` -> newest time persona A replied to a comment by persona B (cooldown window only). */
  pairLast: Map<string, Date>;
  communityActivity: Map<string, number>;
  communityActivityTotal: number;
  /** `${personaId}:${targetId}`. */
  votedTargets: Set<string>;
  /** Targets with a live (queued, not yet expired) job. */
  queuedReplyTargets: Set<string>;
  queuedRevisionTargets: Set<string>;
  queuedSummaryThreads: Set<string>;
  sizes: Record<string, number>;
}

export function usageOf(snap: SchedulerSnapshot, personaId: string): PersonaUsage {
  let u = snap.usage.get(personaId);
  if (!u) {
    u = { contentToday: 0, votesToday: 0, lastContentAt: null };
    snap.usage.set(personaId, u);
  }
  return u;
}

function bump(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function later(a: Date | null, b: Date): Date {
  return a && a.getTime() > b.getTime() ? a : b;
}

interface DecisionRow {
  kind: ActionKind;
  personaId: string | null;
  communityId: string | null;
  threadId: string | null;
  targetId: string | null;
  outcome: string;
  notAfter: Date;
  createdAt: Date;
}

/** Loads everything one tick needs in a fixed, small number of queries (ten, plus the budget status). */
export async function loadSnapshot(
  db: DbOrTx,
  config: AgoraConfig,
  now: Date,
): Promise<SchedulerSnapshot> {
  const dayStart = belgradeDayStart(now);
  const hourAgo = new Date(now.getTime() - HOUR_MS);
  const activitySince = new Date(now.getTime() - SNAPSHOT_LIMITS.activityWindowHours * HOUR_MS);
  const decisionsSince = new Date(Math.min(dayStart.getTime(), activitySince.getTime()));
  const threadsSince = new Date(
    now.getTime() - SNAPSHOT_LIMITS.threadWindowDays * 24 * HOUR_MS,
  );
  const commentsSince = new Date(now.getTime() - SNAPSHOT_LIMITS.commentWindowHours * HOUR_MS);
  const day1Ago = new Date(now.getTime() - 24 * HOUR_MS);
  const freshSince = new Date(now.getTime() - config.news.candidateFreshnessHours * HOUR_MS);
  const pairSince = new Date(now.getTime() - config.scheduler.pairCooldownMinutes * 60_000);
  const iso = (d: Date) => d.toISOString();

  // 1. Personas with memberships.
  const personaRows = await db
    .select({
      id: personas.id,
      displayName: personas.displayName,
      interests: personas.interests,
      limits: personas.limits,
      isSuspended: personas.isSuspended,
      communityId: communityMemberships.communityId,
      affinity: communityMemberships.affinity,
    })
    .from(personas)
    .leftJoin(communityMemberships, eq(communityMemberships.personaId, personas.id));
  const personaMap = new Map<string, PersonaInfo>();
  for (const row of personaRows) {
    let p = personaMap.get(row.id);
    if (!p) {
      p = {
        id: row.id,
        displayName: row.displayName,
        interests: row.interests,
        limits: row.limits,
        isSuspended: row.isSuspended,
        affinity: new Map(),
      };
      personaMap.set(row.id, p);
    }
    if (row.communityId && row.affinity !== null) p.affinity.set(row.communityId, row.affinity);
  }

  // 2. Scheduler decisions of the Belgrade day / activity window.
  const decisionRows: DecisionRow[] = await db
    .select({
      kind: schedulerDecisions.kind,
      personaId: schedulerDecisions.personaId,
      communityId: schedulerDecisions.communityId,
      threadId: schedulerDecisions.threadId,
      targetId: schedulerDecisions.targetId,
      outcome: schedulerDecisions.outcome,
      notAfter: schedulerDecisions.notAfter,
      createdAt: schedulerDecisions.createdAt,
    })
    .from(schedulerDecisions)
    .where(gte(schedulerDecisions.createdAt, decisionsSince));

  // 3. Newest content per persona, whoever created it (seed, admin, scheduler).
  const lastRows = await db.execute<{ id: string; at: Date }>(sql`
    select author_persona_id as id, max(created_at) as at from (
      select author_persona_id, created_at from comments
        where status = 'published' and created_at >= ${iso(day1Ago)}::timestamptz
      union all
      select author_persona_id, created_at from threads
        where status = 'published' and created_at >= ${iso(day1Ago)}::timestamptz
    ) x group by 1`);

  // 4. Threads, with summary coverage, question intent and fresh evidence resolved in SQL.
  const threadRows = await db
    .select({
      id: threads.id,
      communityId: threads.communityId,
      title: threads.title,
      authorPersonaId: threads.authorPersonaId,
      commentCount: threads.commentCount,
      createdAt: threads.createdAt,
      lastActivityAt: threads.lastActivityAt,
      revision: threads.revision,
      score: threads.score,
      summaryCovers: sql<number>`coalesce((select s.covers_comment_count from thread_summaries s
        where s.thread_id = threads.id and s.invalidated_at is null
        order by s.revision desc limit 1), 0)`,
      creatingIntent: sql<string | null>`(select a.intent from agent_actions a
        where a.result_id = threads.id and a.action_type = 'create_thread' limit 1)`,
      hasFreshEvidence: sql<boolean>`exists (select 1 from citations c join articles ar on ar.id = c.article_id
        where ar.published_at >= ${iso(freshSince)}::timestamptz and (
          (c.target_type = 'thread' and c.target_id = threads.id)
          or (c.target_type = 'comment' and c.target_id in
            (select cm.id from comments cm where cm.thread_id = threads.id))))`,
    })
    .from(threads)
    .where(and(eq(threads.status, "published"), gte(threads.lastActivityAt, threadsSince)))
    .orderBy(desc(threads.lastActivityAt))
    .limit(SNAPSHOT_LIMITS.threadLimit);
  const threadIds = threadRows.map((t) => t.id);

  // 5-8 need thread ids; skipped on an empty forum.
  let commentRows: (typeof comments.$inferSelect & { intent: string | null })[] = [];
  let perPersonaRows: {
    threadId: string;
    personaId: string;
    total: number;
    today: number;
    last24h: number;
  }[] = [];
  let voteRows: { voterPersonaId: string; targetId: string }[] = [];
  if (threadIds.length > 0) {
    // 5. Recent published comments with the intent of the action that created them.
    const joined = await db
      .select({ comment: comments, intent: agentActions.intent })
      .from(comments)
      .leftJoin(
        agentActions,
        and(eq(agentActions.resultId, comments.id), eq(agentActions.actionType, "reply")),
      )
      .where(
        and(
          inArray(comments.threadId, threadIds),
          eq(comments.status, "published"),
          gte(comments.createdAt, commentsSince),
        ),
      )
      .orderBy(desc(comments.createdAt))
      .limit(SNAPSHOT_LIMITS.commentLimit);
    commentRows = joined.map((r) => ({ ...r.comment, intent: r.intent }));

    // 6. Per persona and thread: all-time, today, and last-24h comment counts.
    const grouped = await db
      .select({
        threadId: comments.threadId,
        personaId: comments.authorPersonaId,
        total: sql<number>`count(*)::int`,
        today: sql<number>`(count(*) filter (where ${comments.createdAt} >= ${iso(dayStart)}::timestamptz))::int`,
        last24h: sql<number>`(count(*) filter (where ${comments.createdAt} >= ${iso(day1Ago)}::timestamptz))::int`,
      })
      .from(comments)
      .where(and(inArray(comments.threadId, threadIds), eq(comments.status, "published")))
      .groupBy(comments.threadId, comments.authorPersonaId);
    perPersonaRows = grouped;

    // 7. Existing votes on the loaded threads' content.
    voteRows = await db
      .select({ voterPersonaId: votes.voterPersonaId, targetId: votes.targetId })
      .from(votes)
      .where(inArray(votes.threadId, threadIds));
  }

  // 8. Who replied to whom lately (pair cooldown).
  const pairRows =
    config.scheduler.pairCooldownMinutes > 0
      ? await db.execute<{ a: string; b: string; at: Date }>(sql`
          select c.author_persona_id as a, p.author_persona_id as b, max(c.created_at) as at
          from comments c join comments p on p.id = c.parent_comment_id
          where c.status = 'published' and c.created_at >= ${iso(pairSince)}::timestamptz
          group by 1, 2`)
      : { rows: [] as { a: string; b: string; at: Date }[] };

  // 9. Published threads and comments per community in the activity window.
  const activityRows = await db.execute<{ community_id: string; n: number }>(sql`
    select community_id, count(*)::int as n from (
      select community_id from threads
        where status = 'published' and created_at >= ${iso(activitySince)}::timestamptz
      union all
      select t.community_id from comments c join threads t on t.id = c.thread_id
        where c.status = 'published' and c.created_at >= ${iso(activitySince)}::timestamptz
    ) x group by 1`);

  // 10. Communities and the newest thread of each.
  const communityRows = await db.execute<{
    id: string;
    is_active: boolean;
    newest: Date | null;
  }>(
    sql`select c.id, c.is_active, max(t.created_at) filter (where t.status = 'published') as newest
        from communities c left join threads t on t.community_id = c.id group by c.id, c.is_active`,
  );

  // ---- Assemble. ----
  const snap: SchedulerSnapshot = {
    now,
    hour: belgradeHour(now),
    dayStart,
    personas: [...personaMap.values()],
    activePersonaCount: [...personaMap.values()].filter((p) => !p.isSuspended).length,
    communities: new Map(),
    threads: [],
    threadsById: new Map(),
    comments: [],
    commentsById: new Map(),
    usedToday: emptyCounts(),
    plannedLastHour: emptyCounts(),
    usage: new Map(),
    threadContributions: new Map(),
    personaThreadComments: new Map(),
    pairLast: new Map(),
    communityActivity: new Map(),
    communityActivityTotal: 0,
    votedTargets: new Set(),
    queuedReplyTargets: new Set(),
    queuedRevisionTargets: new Set(),
    queuedSummaryThreads: new Set(),
    sizes: {},
  };

  for (const row of communityRows.rows) {
    snap.communities.set(row.id, {
      id: row.id,
      isActive: row.is_active,
      newestThreadAt: row.newest ? new Date(row.newest) : null,
    });
  }

  for (const row of activityRows.rows) {
    snap.communityActivity.set(row.community_id, row.n);
    snap.communityActivityTotal += row.n;
  }

  const last24hByThread = new Map<string, number>();
  for (const row of perPersonaRows) {
    const key = `${row.personaId}:${row.threadId}`;
    snap.personaThreadComments.set(key, row.total);
    if (row.today > 0) snap.threadContributions.set(key, row.today);
    last24hByThread.set(row.threadId, (last24hByThread.get(row.threadId) ?? 0) + row.last24h);
  }

  for (const t of threadRows) {
    const thread: SnapshotThread = {
      id: t.id,
      communityId: t.communityId,
      title: t.title,
      authorPersonaId: t.authorPersonaId,
      commentCount: t.commentCount,
      createdAt: t.createdAt,
      lastActivityAt: t.lastActivityAt,
      revision: t.revision,
      score: t.score,
      isQuestion: t.title.trimEnd().endsWith("?") || t.creatingIntent === "ask_question",
      hasFreshEvidence: Boolean(t.hasFreshEvidence),
      commentsLast24h: last24hByThread.get(t.id) ?? 0,
      summaryCovers: Number(t.summaryCovers ?? 0),
    };
    snap.threads.push(thread);
    snap.threadsById.set(thread.id, thread);
  }

  for (const c of commentRows) {
    const comment: SnapshotComment = {
      id: c.id,
      threadId: c.threadId,
      parentCommentId: c.parentCommentId,
      authorPersonaId: c.authorPersonaId,
      depth: c.depth,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      replyCount: c.replyCount,
      revision: c.revision,
      score: c.score,
      isQuestion: c.body.slice(-200).includes("?") || c.intent === "ask_question",
      intent: (c.intent as Intent | null) ?? null,
    };
    snap.comments.push(comment);
    snap.commentsById.set(comment.id, comment);
  }

  for (const v of voteRows) snap.votedTargets.add(`${v.voterPersonaId}:${v.targetId}`);

  for (const row of lastRows.rows) {
    usageOf(snap, row.id).lastContentAt = new Date(row.at);
  }

  for (const row of pairRows.rows) snap.pairLast.set(`${row.a}:${row.b}`, new Date(row.at));

  // Scheduler decisions: daily usage, planned-last-hour, in-flight work, queued contributions.
  for (const d of decisionRows) {
    const counted = COUNTED_OUTCOMES.has(d.outcome);
    if (counted && d.createdAt >= dayStart) {
      snap.usedToday[d.kind] += 1;
      if (d.personaId) {
        const u = usageOf(snap, d.personaId);
        if (d.kind === "vote") u.votesToday += 1;
        else if (d.kind !== "summary") u.contentToday += 1;
        if (d.kind === "thread" || d.kind === "reply")
          u.lastContentAt = later(u.lastContentAt, d.createdAt);
      }
    }
    if (d.createdAt >= hourAgo) snap.plannedLastHour[d.kind] += 1;
    if (d.communityId && d.outcome !== "skipped" && d.createdAt >= activitySince) {
      bump(snap.communityActivity, d.communityId);
      snap.communityActivityTotal += 1;
    }
    if (
      d.outcome === "queued" &&
      d.kind === "reply" &&
      d.personaId &&
      d.createdAt >= dayStart
    ) {
      if (d.threadId) bump(snap.threadContributions, `${d.personaId}:${d.threadId}`);
      const target = d.targetId ? snap.commentsById.get(d.targetId) : undefined;
      if (target && d.createdAt >= pairSince) {
        const key = `${d.personaId}:${target.authorPersonaId}`;
        const prev = snap.pairLast.get(key);
        snap.pairLast.set(key, prev && prev > d.createdAt ? prev : d.createdAt);
      }
    }
    if (d.outcome === "queued" && d.notAfter > now && d.targetId) {
      if (d.kind === "reply") snap.queuedReplyTargets.add(d.targetId);
      if (d.kind === "revision") snap.queuedRevisionTargets.add(d.targetId);
      if (d.kind === "vote" && d.personaId)
        snap.votedTargets.add(`${d.personaId}:${d.targetId}`);
    }
    if (d.outcome === "queued" && d.notAfter > now && d.kind === "summary" && d.threadId) {
      snap.queuedSummaryThreads.add(d.threadId);
    }
  }

  snap.sizes = {
    personas: snap.personas.length,
    threads: snap.threads.length,
    comments: snap.comments.length,
    decisions: decisionRows.length,
    votes: voteRows.length,
  };
  return snap;
}

/** What a chosen decision changes in the in-memory snapshot, so later slots honour every limit. */
export interface PickEffect {
  kind: ActionKind;
  personaId: string | null;
  communityId: string | null;
  threadId: string | null;
  targetId: string | null;
  targetType: "thread" | "comment" | null;
}

export function applyPick(snap: SchedulerSnapshot, pick: PickEffect): void {
  const { kind, personaId, communityId, threadId, targetId } = pick;
  snap.usedToday[kind] += 1;
  snap.plannedLastHour[kind] += 1;
  if (communityId) {
    bump(snap.communityActivity, communityId);
    snap.communityActivityTotal += 1;
  }
  if (personaId) {
    const u = usageOf(snap, personaId);
    if (kind === "vote") u.votesToday += 1;
    else if (kind !== "summary") u.contentToday += 1;
    if (kind === "thread" || kind === "reply") u.lastContentAt = snap.now;
  }
  switch (kind) {
    case "thread": {
      const community = communityId ? snap.communities.get(communityId) : undefined;
      if (community) community.newestThreadAt = snap.now;
      break;
    }
    case "reply": {
      if (!personaId || !threadId) break;
      bump(snap.threadContributions, `${personaId}:${threadId}`);
      bump(snap.personaThreadComments, `${personaId}:${threadId}`);
      const thread = snap.threadsById.get(threadId);
      if (thread) {
        thread.commentCount += 1;
        thread.commentsLast24h += 1;
      }
      if (targetId) snap.queuedReplyTargets.add(targetId);
      const target = targetId ? snap.commentsById.get(targetId) : undefined;
      if (target) {
        target.replyCount += 1;
        snap.pairLast.set(`${personaId}:${target.authorPersonaId}`, snap.now);
      }
      break;
    }
    case "revision":
      if (targetId) snap.queuedRevisionTargets.add(targetId);
      break;
    case "summary":
      if (threadId) snap.queuedSummaryThreads.add(threadId);
      break;
    case "vote":
      if (personaId && targetId) snap.votedTargets.add(`${personaId}:${targetId}`);
      break;
  }
}
