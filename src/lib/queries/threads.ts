import { and, desc, eq, gt, isNotNull, or, sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import { citations, articles, sources, communities, personas, threads } from "@/lib/db/schema";
import { decodeCursor, encodeCursor } from "./cursor";

export type FeedSort = "novo" | "aktivno" | "najbolje";

export const FEED_SORTS: { key: FeedSort | "fokus"; label: string }[] = [
  { key: "fokus", label: "U fokusu" },
  { key: "novo", label: "Najnovije" },
  { key: "aktivno", label: "Aktivno" },
  { key: "najbolje", label: "Najbolje" },
];

export interface ThreadListItem {
  id: string;
  title: string;
  excerpt: string;
  script: "Latin" | "Cyrillic";
  community: { slug: string; name: string };
  author: { slug: string; displayName: string; avatarSeed: string };
  score: number;
  commentCount: number;
  createdAt: Date;
  lastActivityAt: Date;
  isPinned: boolean;
  featuredRank: number | null;
  tags: string[];
  revision: number;
}

const listColumns = {
  id: threads.id,
  title: threads.title,
  excerpt: sql<string>`left(${threads.body}, 280)`,
  script: threads.script,
  communitySlug: communities.slug,
  communityName: communities.name,
  authorSlug: personas.slug,
  authorName: personas.displayName,
  authorSeed: personas.avatarSeed,
  score: threads.score,
  commentCount: threads.commentCount,
  createdAt: threads.createdAt,
  lastActivityAt: threads.lastActivityAt,
  isPinned: threads.isPinned,
  featuredRank: threads.featuredRank,
  tags: threads.tags,
  revision: threads.revision,
};

function baseQuery(db: DbOrTx) {
  return db
    .select(listColumns)
    .from(threads)
    .innerJoin(communities, eq(communities.id, threads.communityId))
    .innerJoin(personas, eq(personas.id, threads.authorPersonaId));
}

type Row = Awaited<ReturnType<typeof baseQuery>>[number];

function toItem(row: Row): ThreadListItem {
  return {
    id: row.id,
    title: row.title,
    excerpt: row.excerpt,
    script: row.script,
    community: { slug: row.communitySlug, name: row.communityName },
    author: { slug: row.authorSlug, displayName: row.authorName, avatarSeed: row.authorSeed },
    score: row.score,
    commentCount: row.commentCount,
    createdAt: row.createdAt,
    lastActivityAt: row.lastActivityAt,
    isPinned: row.isPinned,
    featuredRank: row.featuredRank,
    tags: row.tags,
    revision: row.revision,
  };
}

export interface ListThreadsParams {
  sort: FeedSort;
  communityId?: string;
  cursor?: string | null;
  limit?: number;
}

export interface ThreadPage {
  items: ThreadListItem[];
  nextCursor: string | null;
}

/** Keyset-paginated thread lists for the three sortable feeds. */
export async function listThreads(db: DbOrTx, params: ListThreadsParams): Promise<ThreadPage> {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);
  const cursor = decodeCursor(params.cursor);
  const conditions: SQL[] = [eq(threads.status, "published")];
  if (params.communityId) conditions.push(eq(threads.communityId, params.communityId));

  let orderBy: SQL[];
  if (params.sort === "novo") {
    orderBy = [desc(threads.createdAt), desc(threads.id)];
    if (cursor) {
      const v = new Date(cursor.v);
      conditions.push(
        or(
          sql`${threads.createdAt} < ${v}`,
          and(sql`${threads.createdAt} = ${v}`, sql`${threads.id} < ${cursor.id}`),
        ) as SQL,
      );
    }
  } else if (params.sort === "aktivno") {
    orderBy = [desc(threads.lastActivityAt), desc(threads.id)];
    if (cursor) {
      const v = new Date(cursor.v);
      conditions.push(
        or(
          sql`${threads.lastActivityAt} < ${v}`,
          and(sql`${threads.lastActivityAt} = ${v}`, sql`${threads.id} < ${cursor.id}`),
        ) as SQL,
      );
    }
  } else {
    orderBy = [desc(threads.score), desc(threads.id)];
    if (cursor) {
      const v = Number.parseInt(cursor.v, 10);
      conditions.push(
        or(
          sql`${threads.score} < ${v}`,
          and(sql`${threads.score} = ${v}`, sql`${threads.id} < ${cursor.id}`),
        ) as SQL,
      );
    }
  }

  const rows = await baseQuery(db)
    .where(and(...conditions))
    .orderBy(...orderBy)
    .limit(limit + 1);
  const page = rows.slice(0, limit).map((row) => toItem(row as Row));
  const last = page.at(-1);
  let nextCursor: string | null = null;
  if (rows.length > limit && last) {
    const v =
      params.sort === "novo"
        ? last.createdAt.toISOString()
        : params.sort === "aktivno"
          ? last.lastActivityAt.toISOString()
          : String(last.score);
    nextCursor = encodeCursor({ v, id: last.id });
  }
  return { items: page, nextCursor };
}

/** Curated "U fokusu": featured by rank, then pinned, then the week's best. */
export async function listFocusThreads(
  db: DbOrTx,
  options: { communityId?: string; limit?: number } = {},
) {
  const limit = options.limit ?? 12;
  const scope = options.communityId ? eq(threads.communityId, options.communityId) : undefined;
  const featured = await baseQuery(db)
    .where(and(eq(threads.status, "published"), isNotNull(threads.featuredRank), scope))
    .orderBy(threads.featuredRank);
  const pinned = await baseQuery(db)
    .where(and(eq(threads.status, "published"), eq(threads.isPinned, true), scope))
    .orderBy(desc(threads.pinnedAt));
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const best = await baseQuery(db)
    .where(and(eq(threads.status, "published"), gt(threads.createdAt, weekAgo), scope))
    .orderBy(desc(threads.score), desc(threads.commentCount), desc(threads.createdAt))
    .limit(limit);
  const seen = new Set<string>();
  const merged: ThreadListItem[] = [];
  for (const row of [...featured, ...pinned, ...best]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(toItem(row as Row));
    if (merged.length >= limit) break;
  }
  return merged;
}

export interface ThreadDetail extends ThreadListItem {
  body: string;
  status: "published" | "hidden" | "quarantined";
  updatedAt: Date;
  communityDescription: string;
  citations: {
    id: string;
    claimExcerpt: string;
    article: {
      id: string;
      title: string;
      canonicalUrl: string;
      publishedAt: Date;
      isFixture: boolean;
      publisher: string;
    };
  }[];
}

export async function getThreadDetail(db: DbOrTx, id: string): Promise<ThreadDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const rows = await db
    .select({
      ...listColumns,
      body: threads.body,
      status: threads.status,
      updatedAt: threads.updatedAt,
      communityDescription: communities.description,
    })
    .from(threads)
    .innerJoin(communities, eq(communities.id, threads.communityId))
    .innerJoin(personas, eq(personas.id, threads.authorPersonaId))
    .where(eq(threads.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const cites = await db
    .select({
      id: citations.id,
      claimExcerpt: citations.claimExcerpt,
      articleId: articles.id,
      title: articles.title,
      canonicalUrl: articles.canonicalUrl,
      publishedAt: articles.publishedAt,
      isFixture: articles.isFixture,
      publisher: sources.publisherName,
    })
    .from(citations)
    .innerJoin(articles, eq(articles.id, citations.articleId))
    .innerJoin(sources, eq(sources.id, articles.sourceId))
    .where(and(eq(citations.targetType, "thread"), eq(citations.targetId, id)))
    .orderBy(citations.createdAt);
  return {
    ...toItem(row as Row),
    body: row.body,
    status: row.status,
    updatedAt: row.updatedAt,
    communityDescription: row.communityDescription,
    citations: cites.map((cite) => ({
      id: cite.id,
      claimExcerpt: cite.claimExcerpt,
      article: {
        id: cite.articleId,
        title: cite.title,
        canonicalUrl: cite.canonicalUrl,
        publishedAt: cite.publishedAt,
        isFixture: cite.isFixture,
        publisher: cite.publisher,
      },
    })),
  };
}

export async function listThreadsByAuthor(
  db: DbOrTx,
  personaId: string,
  limit = 10,
): Promise<ThreadListItem[]> {
  const rows = await baseQuery(db)
    .where(and(eq(threads.status, "published"), eq(threads.authorPersonaId, personaId)))
    .orderBy(desc(threads.createdAt))
    .limit(limit);
  return rows.map((row) => toItem(row as Row));
}
