import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { upsertAdminAccount } from "@/lib/auth/login";
import { getPreset } from "@/lib/config/presets";
import type { AgoraConfig } from "@/lib/config/schema";
import { getActiveConfigRevision, saveConfigRevision } from "@/lib/config/service";
import { createDb, type Db } from "@/lib/db/client";
import { articles, sources } from "@/lib/db/schema";
import { SYSTEM_ACTOR, type Actor } from "@/lib/domain/actors";
import { addComment } from "@/lib/domain/comments";
import { createCommunity, getCommunityBySlug } from "@/lib/domain/communities";
import type { ServiceContext } from "@/lib/domain/context";
import { setFeaturedThreads, setThreadPinned } from "@/lib/domain/curation";
import { isDomainError } from "@/lib/domain/errors";
import { createPersona, getPersonaBySlug, type PersonaRow } from "@/lib/domain/personas";
import { reviseOwnContent } from "@/lib/domain/revisions";
import { createThread, getThreadById, type CitationInput } from "@/lib/domain/threads";
import { castVote } from "@/lib/domain/votes";
import { getEnv, loadDotEnv } from "@/lib/env";
import { COMMUNITY_FIXTURES } from "@/fixtures/communities";
import { PERSONA_FIXTURES } from "@/fixtures/personas";
import { SOURCE_FIXTURES } from "@/fixtures/sources";
import {
  REJECTED_DRAFT_FIXTURES,
  THREAD_FIXTURES,
  type FixtureCitation,
} from "@/fixtures/threads";
import { createProviders } from "@/lib/providers";
import { belgradeHour } from "@/lib/time";

/**
 * Seeds the demo. Everything public goes through the same services and gates
 * the scheduler will use; nothing is written around them. The seed is
 * idempotent: communities, personas, sources, and articles are skipped when
 * present, and every thread, comment, and vote carries a stable action key
 * that replays instead of duplicating.
 *
 * The seed always validates with the mock providers, regardless of runtime
 * mode: the fixtures are hand-written and the seed must never spend money.
 */

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

interface Counters {
  communities: number;
  personas: number;
  sources: number;
  articles: number;
  threads: number;
  comments: number;
  votes: number;
  revisions: number;
  quarantined: number;
  skipped: string[];
}

function belgradeInstant(daysAgo: number, hour: number, now: Date): Date {
  const day = new Date(now.getTime() - daysAgo * DAY);
  const guess = new Date(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, 0, 0),
  );
  const shift = ((belgradeHour(guess) - hour + 36) % 24) - 12;
  return new Date(guess.getTime() - shift * 60 * MINUTE);
}

async function ensureConfig(db: Db): Promise<AgoraConfig> {
  const env = getEnv();
  const active = await getActiveConfigRevision(db);
  if (active) return active.config;
  const preset = getPreset(env.AGORA_CONFIG_PRESET);
  preset.runtime.mode = env.AGORA_RUNTIME_MODE;
  await saveConfigRevision(db, {
    config: preset,
    changeKind: "seed",
    changedByAccountId: null,
    reason: `Početna konfiguracija (preset „${preset.preset}“, režim ${preset.runtime.mode}).`,
  });
  console.log(
    `Config: created revision 1 from preset "${preset.preset}" in ${preset.runtime.mode} mode.`,
  );
  return preset;
}

async function ensureAdmin(db: Db): Promise<void> {
  const env = getEnv();
  if (env.AGORA_ADMIN_USERNAME && env.AGORA_ADMIN_PASSWORD) {
    const result = await upsertAdminAccount(db, {
      username: env.AGORA_ADMIN_USERNAME,
      password: env.AGORA_ADMIN_PASSWORD,
    });
    console.log(
      `Admin: "${env.AGORA_ADMIN_USERNAME}" ${result.created ? "created" : "updated"}.`,
    );
  } else {
    console.log(
      "Admin: not created (set AGORA_ADMIN_USERNAME and AGORA_ADMIN_PASSWORD, then npm run admin:create).",
    );
  }
}

async function ensureSources(
  db: Db,
  now: Date,
  counters: Counters,
): Promise<Map<string, string>> {
  const articleIdByKey = new Map<string, string>();
  for (const fixture of SOURCE_FIXTURES) {
    let sourceRow = (
      await db.select().from(sources).where(eq(sources.slug, fixture.slug)).limit(1)
    )[0];
    if (!sourceRow) {
      [sourceRow] = await db
        .insert(sources)
        .values({
          slug: fixture.slug,
          publisherName: fixture.publisherName,
          websiteUrl: fixture.websiteUrl,
          feedUrl: fixture.feedUrl,
          accessKind: fixture.accessKind,
          category: fixture.category,
          language: fixture.language,
          ownershipGroup: fixture.ownershipGroup,
          fetchPolicy: { intervalMinutes: 30, maxItemsPerFetch: 50, storeExcerptsOnly: true },
          isEnabled: fixture.isEnabled,
          isFixture: fixture.isFixture,
          accessNotes: fixture.accessNotes,
        })
        .returning();
      counters.sources += 1;
    }
    if (!sourceRow) throw new Error(`Source ${fixture.slug} could not be created.`);
    for (const article of fixture.articles) {
      let row = (
        await db
          .select()
          .from(articles)
          .where(eq(articles.canonicalUrl, article.canonicalUrl))
          .limit(1)
      )[0];
      if (!row) {
        const publishedAt = new Date(now.getTime() - article.publishedDaysAgo * DAY);
        [row] = await db
          .insert(articles)
          .values({
            sourceId: sourceRow.id,
            canonicalUrl: article.canonicalUrl,
            title: article.title,
            summary: article.summary,
            language: fixture.language,
            publishedAt,
            retrievedAt: publishedAt,
            isFixture: true,
            contentHash: createHash("sha256")
              .update(`${article.title}\n${article.summary}`)
              .digest("hex"),
          })
          .returning();
        counters.articles += 1;
      }
      if (row) articleIdByKey.set(article.key, row.id);
    }
  }
  return articleIdByKey;
}

function mapCitations(
  list: FixtureCitation[] | undefined,
  articleIdByKey: Map<string, string>,
): CitationInput[] {
  return (list ?? []).map((item) => {
    const articleId = articleIdByKey.get(item.article);
    if (!articleId) throw new Error(`Unknown fixture article "${item.article}".`);
    return { articleId, claimExcerpt: item.claim };
  });
}

async function main(): Promise<void> {
  loadDotEnv();
  const env = getEnv();
  const handle = createDb(env.DATABASE_URL, { max: 4 });
  const db = handle.db;
  const counters: Counters = {
    communities: 0,
    personas: 0,
    sources: 0,
    articles: 0,
    threads: 0,
    comments: 0,
    votes: 0,
    revisions: 0,
    quarantined: 0,
    skipped: [],
  };
  const realNow = new Date();
  const clock = { current: realNow };

  try {
    const activeConfig = await ensureConfig(db);
    await ensureAdmin(db);

    // The seed never runs paused and never touches a live provider.
    const config = structuredClone(activeConfig);
    config.runtime.pauseAllActions = false;
    config.runtime.pausePaidActions = false;
    const ctx: ServiceContext = {
      db,
      config,
      providers: createProviders("mock"),
      now: () => clock.current,
    };

    for (const fixture of COMMUNITY_FIXTURES) {
      if (await getCommunityBySlug(db, fixture.slug)) continue;
      await createCommunity({ actor: SYSTEM_ACTOR, ...fixture }, ctx);
      counters.communities += 1;
    }

    const articleIdByKey = await ensureSources(db, realNow, counters);

    const personaBySlug = new Map<string, PersonaRow>();
    for (const fixture of PERSONA_FIXTURES) {
      let persona = await getPersonaBySlug(db, fixture.slug);
      if (!persona) {
        persona = await createPersona({ actor: SYSTEM_ACTOR, ...fixture }, ctx);
        counters.personas += 1;
      }
      personaBySlug.set(fixture.slug, persona);
    }
    const actorFor = (slug: string): Actor => {
      const persona = personaBySlug.get(slug);
      if (!persona) throw new Error(`Unknown persona fixture "${slug}".`);
      return { kind: "persona", personaId: persona.id, accountId: persona.accountId };
    };

    const featured: { rank: number; threadId: string }[] = [];

    for (const fixture of THREAD_FIXTURES) {
      const threadTime = belgradeInstant(fixture.daysAgo, fixture.hour, realNow);
      clock.current = threadTime;
      const created = await createThread(
        {
          actor: actorFor(fixture.by),
          actionKey: `seed:thread:${fixture.key}`,
          communitySlug: fixture.community,
          title: fixture.title,
          body: fixture.body,
          tags: fixture.tags,
          intent: fixture.intent ?? "introduce_topic",
          citations: mapCitations(fixture.citations, articleIdByKey),
        },
        ctx,
      );
      if (created.status !== "published") {
        counters.skipped.push(`thread ${fixture.key}: ${created.codes.join(", ")}`);
        continue;
      }
      if (!created.replayed) counters.threads += 1;
      const threadId = created.id;

      const commentIdByKey = new Map<string, string>();
      let cursor = threadTime;
      for (const comment of fixture.comments) {
        cursor = new Date(cursor.getTime() + comment.minutesAfter * MINUTE);
        clock.current = cursor;
        const parentCommentId = comment.parentKey
          ? commentIdByKey.get(comment.parentKey)
          : null;
        if (comment.parentKey && !parentCommentId) {
          counters.skipped.push(
            `comment ${fixture.key}/${comment.key}: parent ${comment.parentKey} missing`,
          );
          continue;
        }
        const result = await addComment(
          {
            actor: actorFor(comment.by),
            actionKey: `seed:comment:${fixture.key}:${comment.key}`,
            threadId,
            parentCommentId,
            body: comment.body,
            intent: comment.intent,
            citations: mapCitations(comment.citations, articleIdByKey),
          },
          ctx,
        );
        if (result.status !== "published") {
          counters.skipped.push(
            `comment ${fixture.key}/${comment.key}: ${result.codes.join(", ")}`,
          );
          continue;
        }
        if (!result.replayed) counters.comments += 1;
        commentIdByKey.set(comment.key, result.id);

        for (const [index, vote] of (comment.votes ?? []).entries()) {
          clock.current = new Date(cursor.getTime() + (index + 1) * 7 * MINUTE);
          await seedVote(ctx, actorFor(vote.by), "comment", result.id, vote.value, counters);
        }
        if (comment.revision) {
          clock.current = new Date(cursor.getTime() + comment.revision.minutesAfter * MINUTE);
          await seedRevision(
            ctx,
            actorFor(comment.by),
            `seed:revision:${fixture.key}:${comment.key}`,
            {
              targetType: "comment",
              targetId: result.id,
              body: comment.revision.body,
              reason: comment.revision.reason,
            },
            counters,
          );
        }
      }

      for (const [index, vote] of (fixture.votes ?? []).entries()) {
        clock.current = new Date(threadTime.getTime() + (index + 1) * 37 * MINUTE);
        await seedVote(ctx, actorFor(vote.by), "thread", threadId, vote.value, counters);
      }
      if (fixture.revision) {
        clock.current = new Date(threadTime.getTime() + fixture.revision.minutesAfter * MINUTE);
        await seedRevision(
          ctx,
          actorFor(fixture.by),
          `seed:revision:${fixture.key}`,
          {
            targetType: "thread",
            targetId: threadId,
            title: fixture.revision.title ?? fixture.title,
            body: fixture.revision.body,
            reason: fixture.revision.reason,
          },
          counters,
        );
      }
      if (fixture.pinned && !(await getThreadById(db, threadId))?.isPinned) {
        clock.current = new Date(threadTime.getTime() + 2 * 60 * MINUTE);
        await setThreadPinned(
          { actor: SYSTEM_ACTOR, threadId, pinned: true, reason: "seed" },
          ctx,
        );
      }
      if (fixture.featuredRank) featured.push({ rank: fixture.featuredRank, threadId });
    }

    if (featured.length > 0) {
      clock.current = realNow;
      featured.sort((a, b) => a.rank - b.rank);
      await setFeaturedThreads(
        {
          actor: SYSTEM_ACTOR,
          threadIds: featured
            .map((item) => item.threadId)
            .slice(0, config.news.maxFeaturedStories),
          reason: "seed",
        },
        ctx,
      );
    }

    for (const draft of REJECTED_DRAFT_FIXTURES) {
      clock.current = new Date(realNow.getTime() - 6 * 60 * MINUTE);
      const result = await createThread(
        {
          actor: actorFor(draft.by),
          actionKey: `seed:rejected:${draft.key}`,
          communitySlug: draft.community,
          title: draft.title,
          body: draft.body,
        },
        ctx,
      );
      if (result.status === "quarantined") {
        if (!result.replayed) counters.quarantined += 1;
      } else {
        counters.skipped.push(`rejected draft ${draft.key} unexpectedly published`);
      }
    }

    console.log(
      JSON.stringify(
        {
          created: {
            communities: counters.communities,
            personas: counters.personas,
            sources: counters.sources,
            articles: counters.articles,
            threads: counters.threads,
            comments: counters.comments,
            votes: counters.votes,
            revisions: counters.revisions,
            quarantinedDrafts: counters.quarantined,
          },
          skipped: counters.skipped,
        },
        null,
        2,
      ),
    );
    if (counters.skipped.length > 0) process.exitCode = 2;
  } finally {
    await handle.close();
  }
}

async function seedVote(
  ctx: ServiceContext,
  actor: Actor,
  targetType: "thread" | "comment",
  targetId: string,
  value: 1 | -1,
  counters: Counters,
): Promise<void> {
  try {
    const result = await castVote({ actor, targetType, targetId, value }, ctx);
    if (result.applied === "created") counters.votes += 1;
  } catch (error) {
    if (isDomainError(error)) {
      counters.skipped.push(
        `vote on ${targetType} ${targetId}: ${error.code} ${error.message}`,
      );
      return;
    }
    throw error;
  }
}

async function seedRevision(
  ctx: ServiceContext,
  actor: Actor,
  actionKey: string,
  params: {
    targetType: "thread" | "comment";
    targetId: string;
    title?: string;
    body: string;
    reason: string;
  },
  counters: Counters,
): Promise<void> {
  try {
    const result = await reviseOwnContent(
      { actor, actionKey, expectedRevision: 1, ...params },
      ctx,
    );
    if (result.status === "published") {
      if (!result.replayed) counters.revisions += 1;
    } else {
      counters.skipped.push(`revision ${actionKey}: ${result.codes.join(", ")}`);
    }
  } catch (error) {
    // Already revised on an earlier run: the action key was not replayed because
    // the revision check runs first, so a conflict here means "done".
    if (isDomainError(error, "conflict")) return;
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
