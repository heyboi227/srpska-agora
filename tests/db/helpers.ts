import { sql } from "drizzle-orm";
import { STANDARD_PRESET } from "@/lib/config/presets";
import type { AgoraConfig } from "@/lib/config/schema";
import { createDb, type Db, type DbHandle } from "@/lib/db/client";
import { SYSTEM_ACTOR, type Actor } from "@/lib/domain/actors";
import { createCommunity } from "@/lib/domain/communities";
import type { ServiceContext } from "@/lib/domain/context";
import { createPersona } from "@/lib/domain/personas";
import { loadDotEnv } from "@/lib/env";
import { createProviders } from "@/lib/providers";

const globalForTests = globalThis as unknown as { __agoraTestDb?: DbHandle };

export function testHandle(): DbHandle {
  if (!globalForTests.__agoraTestDb) {
    loadDotEnv();
    const url = process.env.DATABASE_URL_TEST;
    if (!url) throw new Error("DATABASE_URL_TEST must be set to run the database tests.");
    globalForTests.__agoraTestDb = createDb(url, { max: 4 });
  }
  return globalForTests.__agoraTestDb;
}

export function testDb(): Db {
  return testHandle().db;
}

export const APP_TABLES = [
  "citations",
  "votes",
  "comments",
  "threads",
  "content_revisions",
  "moderation_decisions",
  "agent_actions",
  "persona_memories",
  "community_memberships",
  "personas",
  "communities",
  "articles",
  "sources",
  "sessions",
  "login_attempts",
  "config_revisions",
  "worker_heartbeats",
  "accounts",
];

export async function truncateAll(db: Db): Promise<void> {
  await db.execute(
    sql.raw(
      `TRUNCATE TABLE ${APP_TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
    ),
  );
}

/** A controllable clock so tests can move time forward deterministically. */
export class TestClock {
  constructor(public current: Date = new Date("2026-09-10T10:00:00Z")) {}
  now = (): Date => this.current;
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export function makeContext(
  db: Db,
  options: { config?: AgoraConfig; clock?: TestClock } = {},
): ServiceContext & { clock: TestClock } {
  const clock = options.clock ?? new TestClock();
  const config = options.config ?? structuredClone(STANDARD_PRESET);
  return { db, config, providers: createProviders("mock"), now: clock.now, clock };
}

export interface MinimalFixture {
  communitySlug: string;
  personaA: Actor & { kind: "persona" };
  personaB: Actor & { kind: "persona" };
  personaAId: string;
  personaBId: string;
}

const DEFAULT_LIMITS = {
  maxContentActionsPerDay: 12,
  replyCooldownMinutes: 10,
  activeHours: { from: 7, to: 23 },
};

/** One community and two personas created through the real services. */
export async function seedMinimal(ctx: ServiceContext): Promise<MinimalFixture> {
  await createCommunity(
    {
      actor: SYSTEM_ACTOR,
      slug: "kuhinja",
      name: "Kuhinja",
      description: "Ajvar, sarma, pijace i recepti iz cele Srbije.",
      rules:
        "Recepti dobrodošli. Bez uvreda. Navedite izvor kada tvrdite nešto o poreklu jela.",
    },
    ctx,
  );
  const a = await createPersona(
    {
      actor: SYSTEM_ACTOR,
      slug: "slavica",
      displayName: "Slavica iz Zrenjanina",
      bio: "AI sagovornik koji voli zimnicu, pijace i kuhinju Vojvodine.",
      interests: ["kuhinja", "zimnica"],
      style: "Topao, praktičan ton, kratke rečenice.",
      scriptPreference: "Latin",
      vocabularyNotes: "Ekavica.",
      limits: DEFAULT_LIMITS,
      memberships: [{ communitySlug: "kuhinja", affinity: 5 }],
    },
    ctx,
  );
  const b = await createPersona(
    {
      actor: SYSTEM_ACTOR,
      slug: "skeptik",
      displayName: "Skeptik sa izvorom",
      bio: "AI sagovornik koji za svaku tvrdnju traži izvor i datum.",
      interests: ["mediji", "izvori"],
      style: "Kratko, precizno, uvek pita odakle podatak.",
      scriptPreference: "Latin",
      vocabularyNotes: "Ekavica.",
      limits: DEFAULT_LIMITS,
      memberships: [{ communitySlug: "kuhinja", affinity: 2 }],
    },
    ctx,
  );
  return {
    communitySlug: "kuhinja",
    personaA: { kind: "persona", personaId: a.id, accountId: a.accountId },
    personaB: { kind: "persona", personaId: b.id, accountId: b.accountId },
    personaAId: a.id,
    personaBId: b.id,
  };
}

export const SERBIAN_THREAD = {
  title: "Kako čuvate ajvar preko zime u Srbiji?",
  body:
    "Svake jeseni ista dilema: tegle od kile ili manje? Zanima me kako to radite u Vojvodini, a kako u Šumadiji. " +
    "Moje iskustvo je da se ajvar najbolje drži u tamnoj ostavi, ali čujem različita mišljenja.",
};
