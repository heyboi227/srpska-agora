import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { assembleGenerationContext } from "@/lib/context/assemble";
import { BudgetRefusedError } from "@/lib/costs/gateway";
import { agentActions, citations, comments, threads, threadSummaries } from "@/lib/db/schema";
import { moderateContent } from "@/lib/domain/moderation";
import { addComment } from "@/lib/domain/comments";
import { createThread } from "@/lib/domain/threads";
import {
  getLatestSummary,
  isSummaryDue,
  summarizeThread,
  SUMMARY_MAX_CHARACTERS,
} from "@/lib/domain/summaries";
import type {
  GenerationRequest,
  StructuredValidationProvider,
  TextGenerationProvider,
} from "@/lib/providers/types";
import { getLatestThreadSummary } from "@/lib/queries/threads";
import { articles, sources } from "@/lib/db/schema";
import { makeContext, seedMinimal, SERBIAN_THREAD, testDb } from "./helpers";

const MINUTE = 60_000;
const EVERY = 5;

const COMMENTS = [
  "Ja ajvar spremam u manje tegle jer se tako brže potroši.",
  "Tamna ostava je ipak najbolje mesto za zimnicu u kući.",
  "Zanima me da li neko koristi podrum umesto ostave.",
  "U podrumu je vlažnije, pa poklopci znaju da zarđaju.",
  "Šumadinci često prave više ajvara nego što im treba.",
  "Pijace u Vojvodini imaju bolje paprike nego ranije.",
  "Pečenje paprika na šporetu daje drugačiji ukus ajvara.",
  "Sterilizacija tegli je važna da se ajvar ne pokvari.",
  "Moja baka je ajvar čuvala u velikim staklenim teglama.",
  "Razlika u ukusu zavisi i od vrste paprike koja se koristi.",
];

async function setup(opts: { cited?: boolean } = {}) {
  const ctx = makeContext(testDb());
  ctx.config.scheduler.summaryEveryComments = EVERY;
  const fx = await seedMinimal(ctx);
  const created = await createThread(
    {
      actor: fx.personaA,
      actionKey: "sum:thread",
      communitySlug: fx.communitySlug,
      ...SERBIAN_THREAD,
    },
    ctx,
  );
  if (created.status !== "published") throw new Error("thread not published");
  let articleId: string | null = null;
  if (opts.cited) {
    const [source] = await ctx.db
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
      .returning();
    const [article] = await ctx.db
      .insert(articles)
      .values({
        sourceId: source!.id,
        canonicalUrl: "https://example.test/ajvar",
        title: "Cene paprike na pijacama",
        summary: "Cena paprike na pijacama u Srbiji je ove jeseni niža nego lani.",
        language: "sr",
        publishedAt: new Date("2026-09-09T08:00:00Z"),
        contentHash: "h1",
        isFixture: true,
      })
      .returning();
    articleId = article!.id;
    await ctx.db.insert(citations).values({
      targetType: "thread",
      targetId: created.id,
      articleId,
      claimExcerpt: "Cene paprike",
    });
  }
  return { ctx, fx, threadId: created.id, articleId, db: ctx.db };
}

type Setup = Awaited<ReturnType<typeof setup>>;

let counter = 0;
async function addComments(s: Setup, count: number) {
  for (let i = 0; i < count; i++) {
    s.ctx.clock.advance(MINUTE);
    const body = COMMENTS[counter % COMMENTS.length]!;
    const result = await addComment(
      {
        actor: counter % 2 === 0 ? s.fx.personaB : s.fx.personaA,
        actionKey: `sum:comment:${counter}`,
        threadId: s.threadId,
        body: `${body} (${counter + 1})`,
      },
      s.ctx,
    );
    if (result.status !== "published") throw new Error(`comment ${counter} not published`);
    counter += 1;
  }
}

describe("summarizeThread", () => {
  it("is not due before enough comments arrive", async () => {
    const s = await setup();
    await addComments(s, EVERY - 1);
    await expect(
      summarizeThread({ actionKey: "sum:a", threadId: s.threadId }, s.ctx),
    ).rejects.toMatchObject({ code: "invalid", message: "Summary not due." });
    expect(await getLatestSummary(s.db, s.threadId)).toBeNull();
    const due = await isSummaryDue(s.db, s.threadId, EVERY);
    expect(due).toEqual({ due: false, newComments: EVERY - 1, coveredCount: 0 });
  });

  it("writes revision 1, then revision 2 that sees the previous summary", async () => {
    const s = await setup({ cited: true });
    await addComments(s, EVERY);

    const requests: GenerationRequest[] = [];
    const inner = s.ctx.providers.generation;
    const spy: TextGenerationProvider = {
      name: inner.name,
      model: inner.model,
      configured: inner.configured,
      generate: (request, signal) => {
        requests.push(request);
        return inner.generate(request, signal);
      },
    };
    s.ctx.providers = { ...s.ctx.providers, generation: spy };

    const first = await summarizeThread({ actionKey: "sum:1", threadId: s.threadId }, s.ctx);
    expect(first.status).toBe("published");
    if (first.status !== "published") return;
    expect(first.replayed).toBe(false);

    const one = await getLatestSummary(s.db, s.threadId);
    expect(one?.id).toBe(first.id);
    expect(one?.revision).toBe(1);
    expect(one?.coversCommentCount).toBe(EVERY);
    expect(one?.sourceArticleIds).toEqual([s.articleId]);
    expect(one?.body).toContain("Izvor Info");
    expect(one?.body.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARACTERS);
    expect(one?.lastCommentAt).not.toBeNull();
    expect(requests[0]?.purpose).toBe("summary");
    expect(requests[0]?.persona.id).toBe("system-summary");
    expect(requests[0]?.context.threadSummary).toBeUndefined();
    expect(requests[0]?.context.recentComments).toHaveLength(EVERY);
    expect(requests[0]?.context.memory).toEqual([]);
    expect(requests[0]?.maxBodyCharacters).toBe(1500);

    // Right after a summary nothing is due.
    await expect(
      summarizeThread({ actionKey: "sum:2-early", threadId: s.threadId }, s.ctx),
    ).rejects.toMatchObject({ code: "invalid" });

    await addComments(s, EVERY);
    const second = await summarizeThread({ actionKey: "sum:2", threadId: s.threadId }, s.ctx);
    expect(second.status).toBe("published");
    const two = await getLatestSummary(s.db, s.threadId);
    expect(two?.revision).toBe(2);
    expect(two?.coversCommentCount).toBe(EVERY * 2);
    expect(requests[1]?.context.threadSummary).toBe(one?.body);
    // Only comments after the previous summary are offered.
    expect(requests[1]?.context.recentComments).toHaveLength(EVERY);
    expect(two!.lastCommentAt!.getTime()).toBeGreaterThan(one!.lastCommentAt!.getTime());

    const rows = await s.db
      .select()
      .from(threadSummaries)
      .where(eq(threadSummaries.threadId, s.threadId));
    expect(rows).toHaveLength(2);

    const view = await getLatestThreadSummary(s.db, s.threadId);
    expect(view?.revision).toBe(2);
    expect(view?.sources.map((item) => item.publisher)).toEqual(["Izvor Info"]);
  });

  it("replays a used key without creating another summary", async () => {
    const s = await setup();
    await addComments(s, EVERY);
    const first = await summarizeThread(
      { actionKey: "sum:replay", threadId: s.threadId },
      s.ctx,
    );
    const again = await summarizeThread(
      { actionKey: "sum:replay", threadId: s.threadId },
      s.ctx,
    );
    expect(first.status).toBe("published");
    expect(again.status).toBe("published");
    if (first.status !== "published" || again.status !== "published") return;
    expect(again.id).toBe(first.id);
    expect(again.replayed).toBe(true);
    const forced = await summarizeThread(
      { actionKey: "sum:replay", threadId: s.threadId, force: true },
      s.ctx,
    );
    expect(forced.status === "published" && forced.id).toBe(first.id);
    const rows = await s.db.select().from(threadSummaries);
    expect(rows).toHaveLength(1);
  });

  it("refuses while the forum is paused", async () => {
    const s = await setup();
    await addComments(s, EVERY);
    s.ctx.config.runtime.pauseAllActions = true;
    await expect(
      summarizeThread({ actionKey: "sum:paused", threadId: s.threadId }, s.ctx),
    ).rejects.toMatchObject({ code: "paused" });
    expect(await s.db.select().from(threadSummaries)).toHaveLength(0);
  });

  it("quarantines a validator rejection and stores no summary", async () => {
    const s = await setup();
    await addComments(s, EVERY);
    const inner = s.ctx.providers.validation;
    const rejecting: StructuredValidationProvider = {
      name: inner.name,
      model: inner.model,
      configured: true,
      validate: async (request, signal) => ({
        ...(await inner.validate(request, signal)),
        verdict: "reject",
        reasons: ["validator:test_reject"],
      }),
    };
    s.ctx.providers = { ...s.ctx.providers, validation: rejecting };
    const result = await summarizeThread(
      { actionKey: "sum:reject", threadId: s.threadId },
      s.ctx,
    );
    expect(result.status).toBe("quarantined");
    if (result.status !== "quarantined") return;
    expect(result.codes.join(",")).toContain("test_reject");
    expect(await s.db.select().from(threadSummaries)).toHaveLength(0);
    const [action] = await s.db
      .select()
      .from(agentActions)
      .where(eq(agentActions.actionKey, "sum:reject"));
    expect(action?.status).toBe("quarantined");
    expect(action?.actionType).toBe("summarize");
    expect(action?.personaId).toBeNull();
  });

  it("quarantines a body over 1500 characters with summary_too_long", async () => {
    const s = await setup();
    await addComments(s, EVERY);
    const inner = s.ctx.providers.generation;
    const verbose: TextGenerationProvider = {
      name: inner.name,
      model: inner.model,
      configured: true,
      generate: async (request, signal) => {
        const result = await inner.generate(request, signal);
        return { ...result, body: `${result.body} ${"Ostaje otvoreno pitanje. ".repeat(80)}` };
      },
    };
    s.ctx.providers = { ...s.ctx.providers, generation: verbose };
    const result = await summarizeThread(
      { actionKey: "sum:long", threadId: s.threadId },
      s.ctx,
    );
    expect(result.status).toBe("quarantined");
    if (result.status !== "quarantined") return;
    expect(result.codes).toContain("summary_too_long");
    expect(await s.db.select().from(threadSummaries)).toHaveLength(0);
  });

  it("force writes a summary that is not due", async () => {
    const s = await setup();
    await addComments(s, 2);
    const result = await summarizeThread(
      { actionKey: "sum:force", threadId: s.threadId, force: true },
      s.ctx,
    );
    expect(result.status).toBe("published");
    const latest = await getLatestSummary(s.db, s.threadId);
    expect(latest?.coversCommentCount).toBe(2);
  });

  it("does not summarise a thread that is not published", async () => {
    const s = await setup();
    await s.db.update(threads).set({ status: "hidden" }).where(eq(threads.id, s.threadId));
    await expect(
      summarizeThread({ actionKey: "sum:hidden", threadId: s.threadId, force: true }, s.ctx),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("summaries and hidden content", () => {
  it("drops every live summary when a covered comment is hidden, and renumbers the next one", async () => {
    const s = await setup();
    await addComments(s, EVERY);
    const first = await summarizeThread({ actionKey: "inv:1", threadId: s.threadId }, s.ctx);
    if (first.status !== "published") throw new Error("summary 1 not published");
    expect((await getLatestThreadSummary(s.db, s.threadId))?.revision).toBe(1);

    const [covered] = await s.db
      .select({ id: comments.id, body: comments.body })
      .from(comments)
      .where(eq(comments.threadId, s.threadId))
      .orderBy(comments.createdAt)
      .limit(1);
    const hidden = await moderateContent(
      {
        actor: { kind: "admin", accountId: s.fx.personaA.accountId },
        targetType: "comment",
        targetId: covered!.id,
        action: "hide",
        explanation: "Sakriveno zbog kršenja pravila foruma.",
      },
      s.ctx,
    );
    expect(hidden).toBeDefined();

    // Not on the page query, not in the generation context, not the rolling base.
    expect(await getLatestThreadSummary(s.db, s.threadId)).toBeNull();
    expect(await getLatestSummary(s.db, s.threadId)).toBeNull();
    const [thread] = await s.db.select().from(threads).where(eq(threads.id, s.threadId));
    const out = await assembleGenerationContext(
      s.db,
      {
        purpose: "reply",
        personaId: s.fx.personaBId,
        communityId: thread!.communityId,
        threadId: s.threadId,
      },
      s.ctx.now(),
    );
    expect(out.context.threadSummary).toBeUndefined();
    const [row] = await s.db.select().from(threadSummaries);
    expect(row?.invalidatedAt).not.toBeNull();

    // The thread's comment count still stands, so the summary is due again right away.
    expect((await isSummaryDue(s.db, s.threadId, EVERY)).due).toBe(true);

    const requests: GenerationRequest[] = [];
    const inner = s.ctx.providers.generation;
    s.ctx.providers = {
      ...s.ctx.providers,
      generation: {
        name: inner.name,
        model: inner.model,
        configured: inner.configured,
        generate: (request, signal) => {
          requests.push(request);
          return inner.generate(request, signal);
        },
      },
    };
    const next = await summarizeThread({ actionKey: "inv:2", threadId: s.threadId }, s.ctx);
    expect(next.status).toBe("published");
    // The new summary does not roll the invalidated text forward or quote the hidden comment.
    expect(requests[0]?.context.threadSummary).toBeUndefined();
    expect(requests[0]?.context.recentComments).toHaveLength(EVERY - 1);
    expect(JSON.stringify(requests[0]?.context.recentComments)).not.toContain(covered!.body);
    const live = await getLatestThreadSummary(s.db, s.threadId);
    expect(live?.revision).toBe(2);
    const all = await s.db.select().from(threadSummaries);
    expect(all.map((r) => r.revision).sort()).toEqual([1, 2]);
  });

  it("invalidates summaries when a thread is hidden", async () => {
    const s = await setup();
    await addComments(s, EVERY);
    await summarizeThread({ actionKey: "inv:thread", threadId: s.threadId }, s.ctx);
    await moderateContent(
      {
        actor: { kind: "admin", accountId: s.fx.personaA.accountId },
        targetType: "thread",
        targetId: s.threadId,
        action: "hide",
        explanation: "Sakriveno zbog kršenja pravila foruma.",
      },
      s.ctx,
    );
    expect(await getLatestSummary(s.db, s.threadId)).toBeNull();
  });
});

describe("summary draft reuse", () => {
  it("keeps the draft on the proposed row when the validator is busy and reuses it on retry", async () => {
    const s = await setup();
    await addComments(s, EVERY);
    s.ctx.transientValidatorErrors = "throw";
    let generations = 0;
    const gen = s.ctx.providers.generation;
    const validation = s.ctx.providers.validation;
    let busy = true;
    s.ctx.providers = {
      ...s.ctx.providers,
      generation: {
        name: gen.name,
        model: gen.model,
        configured: gen.configured,
        generate: (request, signal) => {
          generations += 1;
          return gen.generate(request, signal);
        },
      },
      validation: {
        name: validation.name,
        model: validation.model,
        configured: validation.configured,
        validate: (request, signal) => {
          if (busy) throw new BudgetRefusedError("busy", "busy");
          return validation.validate(request, signal);
        },
      },
    };
    await expect(
      summarizeThread({ actionKey: "reuse:1", threadId: s.threadId }, s.ctx),
    ).rejects.toBeInstanceOf(BudgetRefusedError);
    const [row] = await s.db
      .select()
      .from(agentActions)
      .where(eq(agentActions.actionKey, "reuse:1"));
    expect(row?.status).toBe("proposed");
    expect(typeof row?.payload.body).toBe("string");

    busy = false;
    const out = await summarizeThread({ actionKey: "reuse:1", threadId: s.threadId }, s.ctx);
    expect(out.status).toBe("published");
    expect(generations).toBe(1);
  });
});
