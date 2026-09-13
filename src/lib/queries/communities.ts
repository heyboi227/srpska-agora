import { asc, eq } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import { communities } from "@/lib/db/schema";

export interface CommunitySummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  rules: string;
  threadCount: number;
  revision: number;
  updatedAt: Date;
}

export async function listActiveCommunities(db: DbOrTx): Promise<CommunitySummary[]> {
  return db
    .select({
      id: communities.id,
      slug: communities.slug,
      name: communities.name,
      description: communities.description,
      rules: communities.rules,
      threadCount: communities.threadCount,
      revision: communities.revision,
      updatedAt: communities.updatedAt,
    })
    .from(communities)
    .where(eq(communities.isActive, true))
    .orderBy(asc(communities.sortOrder), asc(communities.name));
}

export async function getCommunitySummary(
  db: DbOrTx,
  slug: string,
): Promise<CommunitySummary | null> {
  const rows = await db
    .select({
      id: communities.id,
      slug: communities.slug,
      name: communities.name,
      description: communities.description,
      rules: communities.rules,
      threadCount: communities.threadCount,
      revision: communities.revision,
      updatedAt: communities.updatedAt,
    })
    .from(communities)
    .where(eq(communities.slug, slug))
    .limit(1);
  return rows[0] ?? null;
}
