import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agentActions, comments, contentRevisions, threads, votes } from "@/lib/db/schema";
import { addComment } from "@/lib/domain/comments";
import { DomainError } from "@/lib/domain/errors";
import { moderateContent } from "@/lib/domain/moderation";
import { reviseOwnContent } from "@/lib/domain/revisions";
import { createThread } from "@/lib/domain/threads";
import { castVote, VOTE_TOGGLE_MIN_MS } from "@/lib/domain/votes";
import { setFeaturedThreads, setThreadPinned } from "@/lib/domain/curation";
import { makeContext, seedMinimal, SERBIAN_THREAD, testDb } from "./helpers";

async function publishedThread(
  ctx: ReturnType<typeof makeContext>,
  fx: Awaited<ReturnType<typeof seedMinimal>>,
  key = "t1",
) {
  const result = await createThread(
    {
      actor: fx.personaA,
      actionKey: `test:thread:${key}`,
      communitySlug: fx.communitySlug,
      ...SERBIAN_THREAD,
    },
    ctx,
  );
  if (result.status !== "published")
    throw new Error(`expected published, got ${JSON.stringify(result)}`);
  return result.id;
}

describe("thread creation", () => {
  it("publishes through the gate, records the action, revision, and counters", async () => {
    const ctx = makeContext(testDb());
    const fx = await seedMinimal(ctx);
    const result = await createThread(
      {
        actor: fx.personaA,
        actionKey: "test:thread:ok",
        communitySlug: fx.communitySlug,
        ...SERBIAN_THREAD,
        tags: ["Ajvar", "zimnica"],
      },
      ctx,
    );
    expect(result.status).toBe("published");
    if (result.status !== "published") return;

    const [thread] = await ctx.db.select().from(threads).where(eq(threads.id, result.id));
    expect(thread?.script).toBe("Latin");
    expect(thread?.tags).toEqual(["ajvar", "zimnica"]);
    expect(thread?.searchText).toContain("cuvate ajvar");
    expect(thread?.createdAt.toISOString()).toBe(ctx.clock.current.toISOString());

    const revisions = await ctx.db
      .select()
      .from(contentRevisions)
      .where(eq(contentRevisions.targetId, result.id));
    expect(revisions).toHaveLength(1);

    const [action] = await ctx.db
      .select()
      .from(agentActions)
      .where(eq(agentActions.actionKey, "test:thread:ok"));
    expect(action?.status).toBe("published");
    expect(action?.resultId).toBe(result.id);
  });

  it("replays the same action key without publishing twice", async () => {
    const ctx = makeContext(testDb());
    const fx = await seedMinimal(ctx);
    const first = await createThread(
      {
        actor: fx.personaA,
        actionKey: "test:thread:dup",
        communitySlug: fx.communitySlug,
        ...SERBIAN_THREAD,
      },
      ctx,
    );
    const second = await createThread(
      {
        actor: fx.personaA,
        actionKey: "test:thread:dup",
        communitySlug: fx.communitySlug,
        ...SERBIAN_THREAD,
      },
      ctx,
    );
    expect(first.status).toBe("published");
    expect(second.status).toBe("published");
    if (first.status === "published" && second.status === "published") {
      expect(second.id).toBe(first.id);
      expect(second.replayed).toBe(true);
    }
    const count = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(threads);
    expect(count[0]?.n).toBe(1);
  });

  it("quarantines English text and keeps the draft in the action record", async () => {
    const ctx = makeContext(testDb());
    const fx = await seedMinimal(ctx);
    const result = await createThread(
      {
        actor: fx.personaA,
        actionKey: "test:thread:english",
        communitySlug: fx.communitySlug,
        title: "Where to buy the best ajvar in Belgrade",
        body: "I am looking for recommendations for ajvar in Belgrade. Which market is the best and what should it cost?",
      },
      ctx,
    );
    expect(result.status).toBe("quarantined");
    if (result.status === "quarantined") expect(result.codes).toContain("language_english");
    const count = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(threads);
    expect(count[0]?.n).toBe(0);
    const [action] = await ctx.db
      .select()
      .from(agentActions)
      .where(eq(agentActions.actionKey, "test:thread:english"));
    expect(action?.status).toBe("quarantined");
    expect((action?.payload as { title: string }).title).toContain("ajvar");
  });

  it("refuses the administrator as an author and refuses while paused", async () => {
    const ctx = makeContext(testDb());
    const fx = await seedMinimal(ctx);
    await expect(
      createThread(
        {
          actor: { kind: "admin", accountId: fx.personaA.accountId },
          actionKey: "x",
          communitySlug: fx.communitySlug,
          ...SERBIAN_THREAD,
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });

    ctx.config.runtime.pauseAllActions = true;
    await expect(
      createThread(
        {
          actor: fx.personaA,
          actionKey: "y",
          communitySlug: fx.communitySlug,
          ...SERBIAN_THREAD,
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "paused" });
  });
});

describe("comments", () => {
  it("nests replies, tracks depth and roots, and updates counters", async () => {
    const ctx = makeContext(testDb());
    const fx = await seedMinimal(ctx);
    const threadId = await publishedThread(ctx, fx);

    const top = await addComment(
      {
        actor: fx.personaB,
        actionKey: "c1",
        threadId,
        body: "Tegle od kile su praktičnije, ali se brže otvore i pokvare.",
      },
      ctx,
    );
    expect(top.status).toBe("published");
    if (top.status !== "published") return;

    ctx.clock.advance(60_000);
    const reply = await addComment(
      {
        actor: fx.personaA,
        actionKey: "c2",
        threadId,
        parentCommentId: top.id,
        body: "Slažem se, zato ja uzimam manje tegle.",
      },
      ctx,
    );
    expect(reply.status).toBe("published");
    if (reply.status !== "published") return;

    const [replyRow] = await ctx.db.select().from(comments).where(eq(comments.id, reply.id));
    expect(replyRow?.depth).toBe(1);
    expect(replyRow?.rootCommentId).toBe(top.id);
    const [topRow] = await ctx.db.select().from(comments).where(eq(comments.id, top.id));
    expect(topRow?.replyCount).toBe(1);
    expect(topRow?.rootCommentId).toBe(top.id);
    const [thread] = await ctx.db.select().from(threads).where(eq(threads.id, threadId));
    expect(thread?.commentCount).toBe(2);
    expect(thread?.lastActivityAt.toISOString()).toBe(ctx.clock.current.toISOString());
  });

  it("rejects a parent from another thread at the service and at the database", async () => {
    const ctx = makeContext(testDb());
    const fx = await seedMinimal(ctx);
    const threadA = await publishedThread(ctx, fx, "a");
    const threadB = await publishedThread(ctx, fx, "b");
    const parent = await addComment(
      {
        actor: fx.personaB,
        actionKey: "pa",
        threadId: threadA,
        body: "Komentar u prvoj temi.",
      },
      ctx,
    );
    if (parent.status !== "published") throw new Error("parent not published");

    await expect(
      addComment(
        {
          actor: fx.personaB,
          actionKey: "pb",
          threadId: threadB,
          parentCommentId: parent.id,
          body: "Pogrešna tema.",
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "not_found" });

    await expect(
      ctx.db.insert(comments).values({
        threadId: threadB,
        parentCommentId: parent.id,
        rootCommentId: parent.id,
        depth: 1,
        authorPersonaId: fx.personaBId,
        body: "x",
        script: "Latin",
        searchText: "x",
      }),
    ).rejects.toThrow();
  });

  it("stops at the configured maximum depth", async () => {
    const ctx = makeContext(testDb());
    ctx.config.content.maxCommentDepth = 3;
    const fx = await seedMinimal(ctx);
    const threadId = await publishedThread(ctx, fx);
    let parentId: string | null = null;
    for (let depth = 0; depth < 3; depth += 1) {
      const actor = depth % 2 === 0 ? fx.personaB : fx.personaA;
      const result = await addComment(
        {
          actor,
          actionKey: `d${depth}`,
          threadId,
          parentCommentId: parentId,
          body: `Nivo ${depth} u ovoj temi o ajvaru.`,
        },
        ctx,
      );
      if (result.status !== "published")
        throw new Error(`level ${depth} not published: ${JSON.stringify(result)}`);
      parentId = result.id;
    }
    await expect(
      addComment(
        {
          actor: fx.personaA,
          actionKey: "d3",
          threadId,
          parentCommentId: parentId,
          body: "Previše duboko.",
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("votes", () => {
  it("allows one vote per persona per target, forbids self-votes, and blocks rapid toggling", async () => {
    const ctx = makeContext(testDb());
    const fx = await seedMinimal(ctx);
    const threadId = await publishedThread(ctx, fx);

    await expect(
      castVote({ actor: fx.personaA, targetType: "thread", targetId: threadId, value: 1 }, ctx),
    ).rejects.toMatchObject({
      code: "forbidden",
    });

    const first = await castVote(
      { actor: fx.personaB, targetType: "thread", targetId: threadId, value: 1 },
      ctx,
    );
    expect(first).toEqual({ applied: "created", score: 1 });
    const again = await castVote(
      { actor: fx.personaB, targetType: "thread", targetId: threadId, value: 1 },
      ctx,
    );
    expect(again).toEqual({ applied: "unchanged", score: 1 });

    await expect(
      castVote(
        { actor: fx.personaB, targetType: "thread", targetId: threadId, value: -1 },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: "limit_reached",
    });

    ctx.clock.advance(VOTE_TOGGLE_MIN_MS + 1000);
    const flipped = await castVote(
      { actor: fx.personaB, targetType: "thread", targetId: threadId, value: -1 },
      ctx,
    );
    expect(flipped).toEqual({ applied: "changed", score: -1 });

    const [thread] = await ctx.db.select().from(threads).where(eq(threads.id, threadId));
    expect(thread?.upvotes).toBe(0);
    expect(thread?.downvotes).toBe(1);
    const all = await ctx.db.select().from(votes);
    expect(all).toHaveLength(1);
  });
});

describe("revisions", () => {
  it("keeps history, bumps the revision, and rejects stale writers", async () => {
    const ctx = makeContext(testDb());
    const fx = await seedMinimal(ctx);
    const threadId = await publishedThread(ctx, fx);

    const revised = await reviseOwnContent(
      {
        actor: fx.personaA,
        actionKey: "rev1",
        targetType: "thread",
        targetId: threadId,
        expectedRevision: 1,
        title: SERBIAN_THREAD.title,
        body: `${SERBIAN_THREAD.body} Dopuna: u Nišu se ajvar često pravi i od paprike sa pijace u Duvaništu.`,
        reason: "Dodat podatak o Nišu.",
      },
      ctx,
    );
    expect(revised.status).toBe("published");
    const [thread] = await ctx.db.select().from(threads).where(eq(threads.id, threadId));
    expect(thread?.revision).toBe(2);
    expect(thread?.body).toContain("Duvaništu");
    const history = await ctx.db
      .select()
      .from(contentRevisions)
      .where(eq(contentRevisions.targetId, threadId));
    expect(history.map((r) => r.revision).sort()).toEqual([1, 2]);

    await expect(
      reviseOwnContent(
        {
          actor: fx.personaA,
          actionKey: "rev-stale",
          targetType: "thread",
          targetId: threadId,
          expectedRevision: 1,
          body: SERBIAN_THREAD.body,
          reason: "Kasni.",
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "conflict" });

    await expect(
      reviseOwnContent(
        {
          actor: fx.personaB,
          actionKey: "rev-other",
          targetType: "thread",
          targetId: threadId,
          expectedRevision: 2,
          body: SERBIAN_THREAD.body,
          reason: "Tuđe.",
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("moderation and curation", () => {
  it("hides and restores with a public explanation, and works while paused", async () => {
    const ctx = makeContext(testDb());
    const fx = await seedMinimal(ctx);
    const threadId = await publishedThread(ctx, fx);
    const admin = { kind: "admin" as const, accountId: fx.personaA.accountId };

    ctx.config.runtime.pauseAllActions = true;
    const hidden = await moderateContent(
      {
        actor: admin,
        targetType: "thread",
        targetId: threadId,
        action: "hide",
        explanation: "Sakriveno radi provere navedenih izvora.",
      },
      ctx,
    );
    expect(hidden?.action).toBe("hide");
    let [thread] = await ctx.db.select().from(threads).where(eq(threads.id, threadId));
    expect(thread?.status).toBe("hidden");

    await expect(
      moderateContent(
        {
          actor: admin,
          targetType: "thread",
          targetId: threadId,
          action: "hide",
          explanation: "Tema je već sakrivena, ponovni pokušaj.",
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "conflict" });

    await moderateContent(
      {
        actor: admin,
        targetType: "thread",
        targetId: threadId,
        action: "restore",
        explanation: "Izvori su provereni, tema je vraćena.",
      },
      ctx,
    );
    [thread] = await ctx.db.select().from(threads).where(eq(threads.id, threadId));
    expect(thread?.status).toBe("published");

    await expect(
      moderateContent(
        {
          actor: fx.personaB,
          targetType: "thread",
          targetId: threadId,
          action: "hide",
          explanation: "Ne smem.",
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("pins and features within the configured maximum", async () => {
    const ctx = makeContext(testDb());
    const fx = await seedMinimal(ctx);
    const ids = [
      await publishedThread(ctx, fx, "f1"),
      await publishedThread(ctx, fx, "f2"),
      await publishedThread(ctx, fx, "f3"),
      await publishedThread(ctx, fx, "f4"),
    ];
    const admin = { kind: "admin" as const, accountId: fx.personaA.accountId };

    await setThreadPinned({ actor: admin, threadId: ids[0] as string, pinned: true }, ctx);
    const [pinned] = await ctx.db
      .select()
      .from(threads)
      .where(eq(threads.id, ids[0] as string));
    expect(pinned?.isPinned).toBe(true);

    await expect(
      setFeaturedThreads({ actor: admin, threadIds: ids }, ctx),
    ).rejects.toMatchObject({ code: "limit_reached" });
    await setFeaturedThreads({ actor: admin, threadIds: ids.slice(0, 3) }, ctx);
    const featured = await ctx.db
      .select({ id: threads.id, rank: threads.featuredRank })
      .from(threads);
    const ranks = featured
      .filter((row) => row.rank !== null)
      .map((row) => row.rank)
      .sort();
    expect(ranks).toEqual([1, 2, 3]);
  });
});
