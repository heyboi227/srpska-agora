import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { assembleGenerationContext } from "@/lib/context/assemble";
import {
  articles,
  citations,
  comments,
  personaMemories,
  sources,
  threads,
  threadSummaries,
} from "@/lib/db/schema";
import { createThread } from "@/lib/domain/threads";
import {
  MAX_MEMORIES_PER_PERSONA,
  pruneExpiredMemories,
  rememberParticipation,
  rememberView,
} from "@/lib/domain/personas";
import { makeContext, seedMinimal, SERBIAN_THREAD, testDb } from "./helpers";

const T0 = new Date("2026-09-10T10:00:00Z");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

async function setup() {
  const ctx = makeContext(testDb());
  const fx = await seedMinimal(ctx);
  const created = await createThread(
    {
      actor: fx.personaA,
      actionKey: "ctx:thread",
      communitySlug: fx.communitySlug,
      ...SERBIAN_THREAD,
    },
    ctx,
  );
  if (created.status !== "published") throw new Error("thread not published");
  const [thread] = await ctx.db.select().from(threads).where(eq(threads.id, created.id));
  if (!thread) throw new Error("thread missing");
  // Creating the thread left a participation memory; tests start from none.
  await ctx.db.delete(personaMemories);
  return { ctx, fx, thread, db: ctx.db };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** Inserts a comment row directly so tests control body, status, and time. */
async function addRow(
  s: Setup,
  opts: {
    body: string;
    minute: number;
    parent?: { id: string; depth: number; root: string } | null;
    status?: "published" | "hidden" | "quarantined";
    author?: string;
  },
) {
  const id = randomUUID();
  const depth = opts.parent ? opts.parent.depth + 1 : 0;
  const at = new Date(T0.getTime() + opts.minute * MINUTE);
  await s.db.insert(comments).values({
    id,
    threadId: s.thread.id,
    parentCommentId: opts.parent?.id ?? null,
    rootCommentId: opts.parent?.root ?? id,
    depth,
    authorPersonaId: opts.author ?? s.fx.personaBId,
    body: opts.body,
    script: "Latin",
    status: opts.status ?? "published",
    searchText: opts.body.toLowerCase(),
    createdAt: at,
    updatedAt: at,
  });
  return { id, depth, root: opts.parent?.root ?? id };
}

async function addChain(s: Setup, length: number, overrides: Record<number, "hidden"> = {}) {
  const chain: Awaited<ReturnType<typeof addRow>>[] = [];
  for (let i = 0; i < length; i++) {
    chain.push(
      await addRow(s, {
        body: `Lančani komentar broj ${i}`,
        minute: i + 1,
        parent: chain[i - 1] ?? null,
        status: overrides[i] ?? "published",
        author: i % 2 === 0 ? s.fx.personaBId : s.fx.personaAId,
      }),
    );
  }
  return chain;
}

async function addArticle(s: Setup, n: number, daysAgo: number) {
  const existing = await s.db.select().from(sources).where(eq(sources.slug, "izvor"));
  const source =
    existing[0] ??
    (
      await s.db
        .insert(sources)
        .values({
          slug: "izvor",
          publisherName: "Izvor Info",
          websiteUrl: "https://example.test",
          accessKind: "rss",
          category: "vesti",
          language: "sr",
          fetchPolicy: { intervalMinutes: 30, maxItemsPerFetch: 50, storeExcerptsOnly: true },
          isFixture: true,
        })
        .returning()
    )[0]!;
  const [row] = await s.db
    .insert(articles)
    .values({
      sourceId: source.id,
      canonicalUrl: `https://example.test/a${n}`,
      title: `Članak ${n}`,
      summary: "s".repeat(900),
      language: "sr",
      publishedAt: new Date(T0.getTime() - daysAgo * DAY),
      contentHash: `h${n}`,
      isFixture: true,
    })
    .returning();
  return row!;
}

function replyParams(s: Setup, parentCommentId: string | null) {
  return {
    purpose: "reply" as const,
    personaId: s.fx.personaAId,
    communityId: s.thread.communityId,
    threadId: s.thread.id,
    parentCommentId,
  };
}

describe("assembleGenerationContext", () => {
  it("gives a reply the thread's opening post, whitespace-folded and capped at 1,000 characters", async () => {
    const s = await setup();
    const long = `Početni post o ajvaru.${String.fromCharCode(10)}${"x".repeat(1500)}`;
    await s.db.update(threads).set({ body: long }).where(eq(threads.id, s.thread.id));
    const out = await assembleGenerationContext(s.db, replyParams(s, null), s.ctx.now());
    expect(out.context.threadBody?.startsWith("Početni post o ajvaru. xxx")).toBe(true);
    expect(out.context.threadBody?.length).toBe(1000);
    expect(out.context.threadBody?.endsWith("…")).toBe(true);

    await s.db
      .update(threads)
      .set({ body: "Kratak početni post." })
      .where(eq(threads.id, s.thread.id));
    const short = await assembleGenerationContext(s.db, replyParams(s, null), s.ctx.now());
    expect(short.context.threadBody).toBe("Kratak početni post.");
  });

  it("does not add the opening post to a thread or revision context", async () => {
    const s = await setup();
    const out = await assembleGenerationContext(
      s.db,
      {
        purpose: "revision",
        personaId: s.fx.personaAId,
        communityId: s.thread.communityId,
        targetType: "thread",
        targetId: s.thread.id,
        revisionReason: "Dopuna.",
      },
      s.ctx.now(),
    );
    expect(out.context.threadBody).toBeUndefined();
  });

  it("bounds the parent chain to 4, oldest first", async () => {
    const s = await setup();
    const chain = await addChain(s, 6);
    const out = await assembleGenerationContext(
      s.db,
      replyParams(s, chain[5]!.id),
      s.ctx.now(),
    );
    expect(out.context.parentChain?.map((t) => t.body)).toEqual([
      "Lančani komentar broj 2",
      "Lančani komentar broj 3",
      "Lančani komentar broj 4",
      "Lančani komentar broj 5",
    ]);
    expect(out.context.threadTitle).toBe(SERBIAN_THREAD.title);
    expect(out.persona.slug).toBe("slavica");
    expect(out.context.community.slug).toBe("kuhinja");
  });

  it("stops at a hidden ancestor without skipping over it or leaking its text", async () => {
    const s = await setup();
    const chain = await addChain(s, 5, { 2: "hidden" });
    const out = await assembleGenerationContext(
      s.db,
      replyParams(s, chain[4]!.id),
      s.ctx.now(),
    );
    expect(out.context.parentChain?.map((t) => t.body)).toEqual([
      "Lančani komentar broj 3",
      "Lančani komentar broj 4",
    ]);
    expect(JSON.stringify(out.context)).not.toContain("broj 2");
  });

  it("recent comments exclude the chain and hidden comments, oldest first, at most 5", async () => {
    const s = await setup();
    const chain = await addChain(s, 2);
    for (let i = 0; i < 7; i++) {
      await addRow(s, { body: `Sporedni komentar ${i}`, minute: 10 + i });
    }
    await addRow(s, { body: "Sakriven komentar", minute: 30, status: "hidden" });
    await addRow(s, { body: "Karantin komentar", minute: 31, status: "quarantined" });
    const out = await assembleGenerationContext(
      s.db,
      replyParams(s, chain[1]!.id),
      s.ctx.now(),
    );
    expect(out.context.recentComments?.map((t) => t.body)).toEqual([
      "Sporedni komentar 2",
      "Sporedni komentar 3",
      "Sporedni komentar 4",
      "Sporedni komentar 5",
      "Sporedni komentar 6",
    ]);
    const text = JSON.stringify(out.context);
    expect(text).not.toContain("Sakriven");
    expect(text).not.toContain("Karantin");
    expect(out.context.recentComments?.some((t) => t.body.startsWith("Lančani"))).toBe(false);
  });

  it("offers only articles cited on the thread or its published comments", async () => {
    const s = await setup();
    const makeArticle = (n: number, daysAgo: number) => addArticle(s, n, daysAgo);
    const onThread = await makeArticle(1, 3);
    const onComment = await makeArticle(2, 1);
    const onHidden = await makeArticle(3, 0);
    await makeArticle(4, 0); // never cited
    const good = await addRow(s, { body: "Sa izvorom", minute: 5 });
    const bad = await addRow(s, { body: "Skriven sa izvorom", minute: 6, status: "hidden" });
    await s.db.insert(citations).values([
      {
        targetType: "thread",
        targetId: s.thread.id,
        articleId: onThread.id,
        claimExcerpt: "x",
      },
      { targetType: "comment", targetId: good.id, articleId: onComment.id, claimExcerpt: "x" },
      { targetType: "comment", targetId: bad.id, articleId: onHidden.id, claimExcerpt: "x" },
      { targetType: "comment", targetId: good.id, articleId: onThread.id, claimExcerpt: "y" },
    ]);
    const out = await assembleGenerationContext(s.db, replyParams(s, null), s.ctx.now());
    expect(out.context.facts?.map((f) => f.id)).toEqual([onComment.id, onThread.id]);
    expect(out.offeredFactIds).toEqual([onComment.id, onThread.id]);
    expect(out.context.facts?.[0]?.publisher).toBe("Izvor Info");
    expect(out.context.facts?.every((f) => f.summary.length <= 400)).toBe(true);
  });

  it("gives a new thread no facts and no thread context", async () => {
    const s = await setup();
    const out = await assembleGenerationContext(
      s.db,
      {
        purpose: "thread",
        personaId: s.fx.personaAId,
        communityId: s.thread.communityId,
        topicHint: "Zimnica",
      },
      s.ctx.now(),
    );
    expect(out.context.topicHint).toBe("Zimnica");
    expect(out.context.threadTitle).toBeUndefined();
    expect(out.context.facts).toBeUndefined();
    expect(out.offeredFactIds).toEqual([]);
  });

  it("selects memory: not expired, same thread first, at most 8 entries and 800 characters", async () => {
    const s = await setup();
    const now = s.ctx.now();
    const rows = [];
    for (let i = 0; i < 10; i++) {
      rows.push({
        personaId: s.fx.personaAId,
        kind: "participation" as const,
        content: `Opšta beleška ${i} ${"z".repeat(150)}`,
        threadId: null,
        createdAt: new Date(now.getTime() - (i + 5) * MINUTE),
        expiresAt: new Date(now.getTime() + DAY),
      });
    }
    rows.push({
      personaId: s.fx.personaAId,
      kind: "view" as const,
      content: "Beleška iz iste teme",
      threadId: s.thread.id,
      createdAt: new Date(now.getTime() - 2 * DAY),
      expiresAt: new Date(now.getTime() + DAY),
    });
    rows.push({
      personaId: s.fx.personaAId,
      kind: "view" as const,
      content: "Istekla beleška",
      threadId: s.thread.id,
      createdAt: new Date(now.getTime() - 3 * DAY),
      expiresAt: new Date(now.getTime() - 1),
    });
    rows.push({
      personaId: s.fx.personaBId,
      kind: "view" as const,
      content: "Tuđa beleška",
      threadId: null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + DAY),
    });
    await s.db.insert(personaMemories).values(rows);
    const out = await assembleGenerationContext(s.db, replyParams(s, null), now);
    const memory = out.context.memory ?? [];
    expect(memory[0]).toBe("Beleška iz iste teme");
    expect(memory.length).toBeLessThanOrEqual(8);
    expect(memory.join("").length).toBeLessThanOrEqual(800);
    expect(memory.length).toBeGreaterThan(1);
    expect(memory.join("")).not.toContain("Istekla");
    expect(memory.join("")).not.toContain("Tuđa");
  });

  it("keeps the total within 6000 characters with very long bodies", async () => {
    const s = await setup();
    const chain: Awaited<ReturnType<typeof addRow>>[] = [];
    for (let i = 0; i < 5; i++) {
      chain.push(
        await addRow(s, {
          body: `${"Dugačak tekst ".repeat(400)}${i}`,
          minute: i + 1,
          parent: chain[i - 1] ?? null,
        }),
      );
    }
    for (let i = 0; i < 6; i++) {
      await addRow(s, { body: "Opet dugačko. ".repeat(300), minute: 20 + i });
    }
    for (let n = 1; n <= 5; n++) {
      const article = await addArticle(s, n, n);
      await s.db.insert(citations).values({
        targetType: "thread",
        targetId: s.thread.id,
        articleId: article.id,
        claimExcerpt: "x",
      });
    }
    await s.db.insert(threadSummaries).values({
      threadId: s.thread.id,
      revision: 1,
      body: "Sažetak. ".repeat(500),
      script: "Latin",
      coversCommentCount: 3,
    });
    for (let i = 0; i < 9; i++) {
      await rememberParticipation(
        s.db,
        { personaId: s.fx.personaAId, threadId: s.thread.id, content: "m".repeat(190) },
        new Date(s.ctx.now().getTime() - i * MINUTE),
      );
    }
    const out = await assembleGenerationContext(
      s.db,
      replyParams(s, chain[4]!.id),
      s.ctx.now(),
    );
    expect(out.stats.totalChars).toBeLessThanOrEqual(6000);
    expect(out.stats.trimmed.length).toBeGreaterThan(0);
    expect(out.offeredFactIds.length).toBeLessThanOrEqual(4);
    expect(out.context.parentChain).toHaveLength(4);
    expect(out.context.parentChain?.every((t) => t.body.length <= 500)).toBe(true);
    expect(out.context.threadSummary?.length ?? 0).toBeLessThanOrEqual(1200);
  });

  it("gives a revision the target's current body and reason", async () => {
    const s = await setup();
    const out = await assembleGenerationContext(
      s.db,
      {
        purpose: "revision",
        personaId: s.fx.personaAId,
        communityId: s.thread.communityId,
        targetType: "thread",
        targetId: s.thread.id,
        revisionReason: "Preciznija formulacija",
      },
      s.ctx.now(),
    );
    expect(out.context.currentBody).toBe(SERBIAN_THREAD.body);
    expect(out.context.revisionReason).toBe("Preciznija formulacija");
    expect(out.context.threadTitle).toBe(SERBIAN_THREAD.title);
  });

  it("refuses to build context for a hidden thread", async () => {
    const s = await setup();
    await s.db.update(threads).set({ status: "hidden" }).where(eq(threads.id, s.thread.id));
    await expect(
      assembleGenerationContext(s.db, replyParams(s, null), s.ctx.now()),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("persona memory", () => {
  it("rememberView truncates, ignores empty and broken text, and prunes to 60", async () => {
    const s = await setup();
    const personaId = s.fx.personaAId;
    const now = s.ctx.now();
    expect(await rememberView(s.db, { personaId, content: "   " }, now)).toBe(false);
    expect(await rememberView(s.db, { personaId, content: "Lose � kodiranje" }, now)).toBe(
      false,
    );
    expect(await rememberView(s.db, { personaId, content: `  ${"ž".repeat(500)} ` }, now)).toBe(
      true,
    );
    const [row] = await s.db
      .select()
      .from(personaMemories)
      .where(eq(personaMemories.personaId, personaId));
    expect(row?.content).toHaveLength(200);
    expect(row?.kind).toBe("view");
    expect(row?.expiresAt.getTime()).toBe(now.getTime() + 45 * DAY);

    for (let i = 1; i <= 65; i++) {
      await rememberView(
        s.db,
        { personaId, threadId: s.thread.id, content: `Stav ${i}` },
        new Date(now.getTime() + i * MINUTE),
      );
    }
    const kept = await s.db
      .select()
      .from(personaMemories)
      .where(eq(personaMemories.personaId, personaId));
    expect(kept).toHaveLength(MAX_MEMORIES_PER_PERSONA);
    expect(kept.some((r) => r.content === "Stav 65")).toBe(true);
    expect(kept.some((r) => r.content === "Stav 5")).toBe(false);
  });

  it("pruneExpiredMemories removes expired entries and trims each persona to 60", async () => {
    const s = await setup();
    const now = s.ctx.now();
    const make = (personaId: string, i: number, expired: boolean) => ({
      personaId,
      kind: "note" as const,
      content: `n${i}`,
      createdAt: new Date(now.getTime() - i * MINUTE),
      expiresAt: new Date(now.getTime() + (expired ? -MINUTE : DAY)),
    });
    await s.db
      .insert(personaMemories)
      .values([
        ...Array.from({ length: 65 }, (_, i) => make(s.fx.personaAId, i, false)),
        ...Array.from({ length: 3 }, (_, i) => make(s.fx.personaAId, 100 + i, true)),
        ...Array.from({ length: 4 }, (_, i) => make(s.fx.personaBId, i, false)),
        make(s.fx.personaBId, 200, true),
      ]);
    expect(await pruneExpiredMemories(s.db, now)).toEqual({ expired: 4, trimmed: 5 });
    const left = await s.db.select().from(personaMemories);
    expect(left.filter((r) => r.personaId === s.fx.personaAId)).toHaveLength(60);
    expect(left.filter((r) => r.personaId === s.fx.personaBId)).toHaveLength(4);
    expect(left.some((r) => r.content === "n64")).toBe(false);
    expect(await pruneExpiredMemories(s.db, now)).toEqual({ expired: 0, trimmed: 0 });
  });
});
