import { asc, desc, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import { articles, sources } from "@/lib/db/schema";

export interface SourceRow {
  id: string;
  slug: string;
  publisherName: string;
  websiteUrl: string;
  feedUrl: string | null;
  accessKind: "rss" | "api" | "html" | "fixture";
  category: string;
  language: string;
  ownershipGroup: string | null;
  isEnabled: boolean;
  isFixture: boolean;
  lastSuccessfulFetchAt: Date | null;
  lastAttemptAt: Date | null;
  lastError: string | null;
  accessNotes: string;
  articleCount: number;
}

export async function listSources(db: DbOrTx): Promise<SourceRow[]> {
  return db
    .select({
      id: sources.id,
      slug: sources.slug,
      publisherName: sources.publisherName,
      websiteUrl: sources.websiteUrl,
      feedUrl: sources.feedUrl,
      accessKind: sources.accessKind,
      category: sources.category,
      language: sources.language,
      ownershipGroup: sources.ownershipGroup,
      isEnabled: sources.isEnabled,
      isFixture: sources.isFixture,
      lastSuccessfulFetchAt: sources.lastSuccessfulFetchAt,
      lastAttemptAt: sources.lastAttemptAt,
      lastError: sources.lastError,
      accessNotes: sources.accessNotes,
      articleCount: sql<number>`(select count(*)::int from ${articles} where ${articles.sourceId} = ${sources.id})`,
    })
    .from(sources)
    .orderBy(desc(sources.isEnabled), asc(sources.isFixture), asc(sources.publisherName));
}

export interface NewsItem {
  id: string;
  title: string;
  summary: string;
  canonicalUrl: string;
  publishedAt: Date;
  retrievedAt: Date;
  isFixture: boolean;
  publisher: string;
  publisherSlug: string;
}

export async function listLatestArticles(db: DbOrTx, limit = 6): Promise<NewsItem[]> {
  return db
    .select({
      id: articles.id,
      title: articles.title,
      summary: articles.summary,
      canonicalUrl: articles.canonicalUrl,
      publishedAt: articles.publishedAt,
      retrievedAt: articles.retrievedAt,
      isFixture: articles.isFixture,
      publisher: sources.publisherName,
      publisherSlug: sources.slug,
    })
    .from(articles)
    .innerJoin(sources, eq(sources.id, articles.sourceId))
    .orderBy(desc(articles.publishedAt))
    .limit(limit);
}

export interface ResearchStatus {
  /** Any real (non-fixture) source enabled at all. */
  configured: boolean;
  lastSuccessfulFetchAt: Date | null;
  enabledSources: number;
  fixtureOnly: boolean;
}

export async function getResearchStatus(db: DbOrTx): Promise<ResearchStatus> {
  const rows = await db
    .select({
      enabled: sql<number>`count(*) filter (where ${sources.isEnabled} and not ${sources.isFixture})::int`,
      lastSuccess: sql<Date | null>`max(${sources.lastSuccessfulFetchAt})`,
      realArticles: sql<number>`(select count(*)::int from ${articles} where not ${articles.isFixture})`,
    })
    .from(sources);
  const row = rows[0];
  const enabled = row?.enabled ?? 0;
  return {
    configured: enabled > 0,
    lastSuccessfulFetchAt: row?.lastSuccess ? new Date(row.lastSuccess) : null,
    enabledSources: enabled,
    fixtureOnly: (row?.realArticles ?? 0) === 0,
  };
}
