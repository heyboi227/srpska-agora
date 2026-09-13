import { asc, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import {
  comments,
  communities,
  communityMemberships,
  personas,
  threads,
} from "@/lib/db/schema";

export interface PersonaCard {
  id: string;
  slug: string;
  displayName: string;
  bio: string;
  interests: string[];
  style: string;
  scriptPreference: "Latin" | "Cyrillic";
  avatarSeed: string;
  isSuspended: boolean;
  threadCount: number;
  commentCount: number;
}

const cardColumns = {
  id: personas.id,
  slug: personas.slug,
  displayName: personas.displayName,
  bio: personas.bio,
  interests: personas.interests,
  style: personas.style,
  scriptPreference: personas.scriptPreference,
  avatarSeed: personas.avatarSeed,
  isSuspended: personas.isSuspended,
  threadCount: sql<number>`(select count(*)::int from ${threads} where ${threads.authorPersonaId} = ${personas.id} and ${threads.status} = 'published')`,
  commentCount: sql<number>`(select count(*)::int from ${comments} where ${comments.authorPersonaId} = ${personas.id} and ${comments.status} = 'published')`,
};

export async function listPersonaCards(db: DbOrTx): Promise<PersonaCard[]> {
  return db.select(cardColumns).from(personas).orderBy(asc(personas.displayName));
}

export interface PersonaProfile extends PersonaCard {
  vocabularyNotes: string;
  createdAt: Date;
  communities: { slug: string; name: string; affinity: number }[];
}

export async function getPersonaProfile(
  db: DbOrTx,
  slug: string,
): Promise<PersonaProfile | null> {
  const rows = await db
    .select({
      ...cardColumns,
      vocabularyNotes: personas.vocabularyNotes,
      createdAt: personas.createdAt,
    })
    .from(personas)
    .where(eq(personas.slug, slug))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const memberships = await db
    .select({
      slug: communities.slug,
      name: communities.name,
      affinity: communityMemberships.affinity,
    })
    .from(communityMemberships)
    .innerJoin(communities, eq(communities.id, communityMemberships.communityId))
    .where(eq(communityMemberships.personaId, row.id))
    .orderBy(sql`${communityMemberships.affinity} desc`, asc(communities.name));
  return { ...row, communities: memberships };
}
