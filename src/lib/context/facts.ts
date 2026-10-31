import { and, desc, eq, inArray, or } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import { articles, citations, comments, sources } from "@/lib/db/schema";
import type { FactItem } from "@/lib/providers/types";
import { clip } from "./budget";

/**
 * Articles cited by a thread or by its published comments, newest publication
 * first. Citations on hidden or quarantined comments are not offered.
 */
export async function loadThreadFacts(
  db: DbOrTx,
  threadId: string,
  limit: number,
  summaryChars: number,
): Promise<FactItem[]> {
  const publishedComments = db
    .select({ id: comments.id })
    .from(comments)
    .where(and(eq(comments.threadId, threadId), eq(comments.status, "published")));
  const rows = await db
    .selectDistinct({
      id: articles.id,
      publisher: sources.publisherName,
      title: articles.title,
      summary: articles.summary,
      publishedAt: articles.publishedAt,
    })
    .from(citations)
    .innerJoin(articles, eq(articles.id, citations.articleId))
    .innerJoin(sources, eq(sources.id, articles.sourceId))
    .where(
      or(
        and(eq(citations.targetType, "thread"), eq(citations.targetId, threadId)),
        and(
          eq(citations.targetType, "comment"),
          inArray(citations.targetId, publishedComments),
        ),
      ),
    )
    .orderBy(desc(articles.publishedAt), articles.id)
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    publisher: row.publisher,
    title: row.title,
    summary: clip(row.summary.replace(/\s+/g, " ").trim(), summaryChars),
    publishedAt: row.publishedAt.toISOString(),
  }));
}
