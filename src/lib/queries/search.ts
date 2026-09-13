import { and, desc, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import { comments, communities, personas, threads } from "@/lib/db/schema";
import { normalizeForSearch } from "@/lib/serbian/normalize";

export interface SearchResults {
  query: string;
  normalized: string;
  tooShort: boolean;
  threads: {
    id: string;
    title: string;
    excerpt: string;
    communitySlug: string;
    communityName: string;
    authorName: string;
    score: number;
    commentCount: number;
    createdAt: Date;
  }[];
  comments: {
    id: string;
    threadId: string;
    threadTitle: string;
    excerpt: string;
    authorName: string;
    createdAt: Date;
  }[];
  communities: { slug: string; name: string; description: string }[];
}

const MIN_QUERY = 2;
const LIMIT = 20;

/**
 * Search over the normalised Latin field, so Cyrillic and Latin queries with or
 * without diacritics find the same rows. Substring matches rank first, then
 * trigram similarity catches typos. Serbian stemming is not attempted.
 */
export async function searchForum(db: DbOrTx, rawQuery: string): Promise<SearchResults> {
  const query = rawQuery.trim().slice(0, 120);
  const normalized = normalizeForSearch(query);
  const empty: SearchResults = {
    query,
    normalized,
    tooShort: true,
    threads: [],
    comments: [],
    communities: [],
  };
  if (normalized.length < MIN_QUERY) return empty;

  const pattern = `%${normalized.replace(/[%_\\]/g, "\\$&")}%`;
  const threadRows = await db
    .select({
      id: threads.id,
      title: threads.title,
      excerpt: sql<string>`left(${threads.body}, 200)`,
      communitySlug: communities.slug,
      communityName: communities.name,
      authorName: personas.displayName,
      score: threads.score,
      commentCount: threads.commentCount,
      createdAt: threads.createdAt,
      exact: sql<boolean>`${threads.searchText} like ${pattern}`,
      sim: sql<number>`similarity(${threads.searchText}, ${normalized})`,
    })
    .from(threads)
    .innerJoin(communities, eq(communities.id, threads.communityId))
    .innerJoin(personas, eq(personas.id, threads.authorPersonaId))
    .where(
      and(
        eq(threads.status, "published"),
        sql`(${threads.searchText} like ${pattern} or similarity(${threads.searchText}, ${normalized}) > 0.12)`,
      ),
    )
    .orderBy(
      sql`(${threads.searchText} like ${pattern}) desc`,
      desc(sql`similarity(${threads.searchText}, ${normalized})`),
      desc(threads.lastActivityAt),
    )
    .limit(LIMIT);

  const commentRows = await db
    .select({
      id: comments.id,
      threadId: comments.threadId,
      threadTitle: threads.title,
      excerpt: sql<string>`left(${comments.body}, 200)`,
      authorName: personas.displayName,
      createdAt: comments.createdAt,
    })
    .from(comments)
    .innerJoin(threads, eq(threads.id, comments.threadId))
    .innerJoin(personas, eq(personas.id, comments.authorPersonaId))
    .where(
      and(
        eq(comments.status, "published"),
        eq(threads.status, "published"),
        sql`${comments.searchText} like ${pattern}`,
      ),
    )
    .orderBy(desc(comments.createdAt))
    .limit(LIMIT);

  const communityRows = await db
    .select({
      slug: communities.slug,
      name: communities.name,
      description: communities.description,
    })
    .from(communities)
    .where(
      and(
        eq(communities.isActive, true),
        sql`(lower(${communities.name}) like ${pattern} or lower(${communities.description}) like ${pattern})`,
      ),
    )
    .limit(10);

  return {
    query,
    normalized,
    tooShort: false,
    threads: threadRows.map(({ exact: _exact, sim: _sim, ...row }) => row),
    comments: commentRows,
    communities: communityRows,
  };
}
