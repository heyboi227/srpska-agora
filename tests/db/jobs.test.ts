import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { SIMULATION_PRICE_TABLE } from "@/lib/costs";
import {
  agentActions,
  comments,
  personaMemories,
  providerRequests,
  schedulerDecisions,
  threadSummaries,
  threads,
  votes,
} from "@/lib/db/schema";
import { addComment } from "@/lib/domain/comments";
import { setPersonaSuspended } from "@/lib/domain/personas";
import { SYSTEM_ACTOR } from "@/lib/domain/actors";
import { recordDeadLetter } from "@/lib/jobs/dead-letter";
import { executeActionJob } from "@/lib/jobs/handlers";
import { MemoryJobQueue } from "@/lib/jobs/memory-queue";
import { jobOptionsFor } from "@/lib/jobs/types";
import { runSchedulerTick } from "@/lib/scheduler";
import { BudgetRefusedError } from "@/lib/costs/gateway";
import { moderateContent } from "@/lib/domain/moderation";
import {
  ProviderCallError,
  ProviderNotConfiguredError,
  type GenerationResult,
} from "@/lib/providers/types";
import { testDb } from "./helpers";
import { ENGLISH_COMMENT, jobHarness, jobsConfig, SERBIAN_COMMENT } from "./jobs-fixture";

const db = testDb();

async function decisionOf(id: string) {
  const [row] = await db.select().from(schedulerDecisions).where(eq(schedulerDecisions.id, id));
  if (!row) throw new Error("decision missing");
  return row;
}

const countComments = async () => (await db.select({ id: comments.id }).from(comments)).length;

function replyPayload(h: Awaited<ReturnType<typeof jobHarness>>) {
  return h.plan("reply", {
    personaId: h.people.personaAId,
    targetType: "comment",
    targetId: h.commentId,
    intent: "disagree",
    contentVersion: { targetRevision: 1 },
  });
}

describe("executeActionJob: re-checks", () => {
  it("publishes a planned reply and records the decision and the action", async () => {
    const h = await jobHarness(db);
    const payload = await replyPayload(h);
    const out = await executeActionJob(payload, h.deps());
    expect(out.outcome).toBe("published");
    expect(out.actionId).not.toBeNull();
    const decision = await decisionOf(payload.decisionId);
    expect(decision.outcome).toBe("published");
    expect(decision.actionId).toBe(out.actionId);
    expect(decision.completedAt).not.toBeNull();
    const [action] = await db
      .select()
      .from(agentActions)
      .where(eq(agentActions.actionKey, payload.actionKey));
    expect(action?.status).toBe("published");
    const [comment] = await db
      .select()
      .from(comments)
      .where(eq(comments.id, out.resultId ?? ""));
    expect(comment?.parentCommentId).toBe(h.commentId);
  });

  it("skips a duplicate delivery without touching the decision or the content", async () => {
    const h = await jobHarness(db);
    const payload = await replyPayload(h);
    await executeActionJob(payload, h.deps());
    const before = await countComments();
    const again = await executeActionJob(payload, h.deps());
    expect(again).toMatchObject({ outcome: "skipped", code: "already_done" });
    expect(await countComments()).toBe(before);
    expect((await decisionOf(payload.decisionId)).outcome).toBe("published");
  });

  it("skips an unknown decision", async () => {
    const h = await jobHarness(db);
    const payload = await replyPayload(h);
    const out = await executeActionJob(
      { ...payload, decisionId: "00000000-0000-4000-8000-000000000000" },
      h.deps(),
    );
    expect(out.code).toBe("no_decision");
  });

  it("skips when the forum was paused after planning", async () => {
    const h = await jobHarness(db);
    const payload = await replyPayload(h);
    h.config.runtime.pauseAllActions = true;
    const out = await executeActionJob(payload, h.deps());
    expect(out).toMatchObject({ outcome: "skipped", code: "paused" });
    expect(h.gen.requests).toHaveLength(0);
    expect((await decisionOf(payload.decisionId)).outcomeCode).toBe("paused");
  });

  it("skips paid work while paid actions are paused, but still lets votes through", async () => {
    const h = await jobHarness(db);
    const reply = await replyPayload(h);
    const vote = await h.plan("vote", {
      personaId: h.people.personaAId,
      targetType: "comment",
      targetId: h.commentId,
      voteValue: 1,
    });
    h.config.runtime.pausePaidActions = true;
    expect((await executeActionJob(reply, h.deps())).code).toBe("paid_paused");
    expect((await executeActionJob(vote, h.deps())).outcome).toBe("published");
  });

  it("skips a job that outlived its notAfter", async () => {
    const h = await jobHarness(db);
    const payload = await replyPayload(h);
    h.clock.advance(31 * 60_000);
    expect((await executeActionJob(payload, h.deps())).code).toBe("stale");
  });

  it("skips when the parent changed after planning", async () => {
    const h = await jobHarness(db);
    const payload = await replyPayload(h);
    await db
      .update(comments)
      .set({ revision: sql`${comments.revision} + 1` })
      .where(eq(comments.id, h.commentId));
    expect((await executeActionJob(payload, h.deps())).code).toBe("content_changed");
    expect(h.gen.requests).toHaveLength(0);
  });

  it("skips when the persona was suspended after planning", async () => {
    const h = await jobHarness(db);
    const payload = await replyPayload(h);
    await setPersonaSuspended(db, {
      actor: SYSTEM_ACTOR,
      personaId: h.people.personaAId,
      suspended: true,
      reason: "test",
    });
    expect((await executeActionJob(payload, h.deps())).code).toBe("persona_inactive");
  });

  it("enforces the persona's daily cap, counting only other decisions", async () => {
    const h = await jobHarness(db, {
      config: jobsConfig((c) => {
        c.personas.maxContentActionsPerPersonaPerDay = 1;
      }),
    });
    const first = await replyPayload(h);
    expect((await executeActionJob(first, h.deps())).outcome).toBe("published");
    h.clock.advance(20 * 60_000);
    const second = await replyPayload(h);
    expect((await executeActionJob(second, h.deps())).code).toBe("persona_limit");
  });

  it("enforces the reply cooldown", async () => {
    const h = await jobHarness(db);
    const first = await replyPayload(h);
    expect((await executeActionJob(first, h.deps())).outcome).toBe("published");
    h.clock.advance(60_000);
    const second = await replyPayload(h);
    expect((await executeActionJob(second, h.deps())).code).toBe("cooldown");
  });

  it("enforces the global daily maximum", async () => {
    const h = await jobHarness(db, {
      config: jobsConfig((c) => {
        c.content.maxNewCommentsPerDay = 1;
      }),
    });
    const first = await replyPayload(h);
    expect((await executeActionJob(first, h.deps())).outcome).toBe("published");
    h.clock.advance(20 * 60_000);
    const second = await h.plan("reply", {
      personaId: h.people.personaBId,
      targetType: "thread",
      targetId: h.threadId,
      contentVersion: { targetRevision: 1 },
    });
    expect((await executeActionJob(second, h.deps())).code).toBe("daily_max");
  });

  it("skips a summary that is no longer due", async () => {
    const h = await jobHarness(db);
    const payload = await h.plan("summary", { personaId: null });
    // One comment since the start; the threshold is two.
    expect((await executeActionJob(payload, h.deps())).code).toBe("not_due");
  });
});

describe("executeActionJob: execution", () => {
  it("casts a vote, and treats a repeat as already voted", async () => {
    const h = await jobHarness(db);
    const vote = await h.plan("vote", {
      personaId: h.people.personaAId,
      targetType: "comment",
      targetId: h.commentId,
      voteValue: 1,
    });
    const out = await executeActionJob(vote, h.deps());
    expect(out).toMatchObject({ outcome: "published", resultId: h.commentId, actionId: null });
    expect(await db.select().from(votes)).toHaveLength(1);

    const repeat = await h.plan("vote", {
      personaId: h.people.personaAId,
      targetType: "comment",
      targetId: h.commentId,
      voteValue: 1,
    });
    expect((await executeActionJob(repeat, h.deps())).code).toBe("already_voted");
  });

  it("writes a thread summary when one is due", async () => {
    const h = await jobHarness(db);
    await addComment(
      {
        actor: h.people.personaA,
        actionKey: "fx:comment2",
        threadId: h.threadId,
        body: SERBIAN_COMMENT,
      },
      {
        db,
        config: h.config,
        providers: h.providers,
        origin: "system",
        now: () => h.clock.now(),
      },
    );
    const payload = await h.plan("summary", { personaId: null });
    const out = await executeActionJob(payload, h.deps());
    expect(out.outcome).toBe("published");
    const rows = await db.select().from(threadSummaries);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(out.resultId);
  });

  it("publishes a new thread and stores the memory note as a view", async () => {
    const h = await jobHarness(db);
    const payload = await h.plan("thread", {
      personaId: h.people.personaBId,
      threadId: null,
      intent: "introduce_topic",
      topicHint: "zimnica",
    });
    const out = await executeActionJob(payload, h.deps());
    expect(out.outcome).toBe("published");
    const [thread] = await db
      .select()
      .from(threads)
      .where(eq(threads.id, out.resultId ?? ""));
    expect(thread?.authorPersonaId).toBe(h.people.personaBId);
    const memories = await db
      .select()
      .from(personaMemories)
      .where(
        and(
          eq(personaMemories.personaId, h.people.personaBId),
          eq(personaMemories.kind, "view"),
        ),
      );
    expect(memories).toHaveLength(1);
    expect(memories[0]?.threadId).toBe(out.resultId);
  });

  it("revises the author's own comment after a challenge", async () => {
    const h = await jobHarness(db);
    const challenge = await addComment(
      {
        actor: h.people.personaA,
        actionKey: "fx:challenge",
        threadId: h.threadId,
        parentCommentId: h.commentId,
        body: "Nisam siguran da je to tačno; imate li izvor za tu tvrdnju o toploti i ukusu ajvara?",
        intent: "disagree",
      },
      {
        db,
        config: h.config,
        providers: h.providers,
        origin: "system",
        now: () => h.clock.now(),
      },
    );
    if (challenge.status !== "published") throw new Error("challenge not published");
    const payload = await h.plan("revision", {
      personaId: h.people.personaBId,
      targetType: "comment",
      targetId: h.commentId,
      relatedCommentId: challenge.id,
      intent: "correct_earlier",
      contentVersion: { targetRevision: 1 },
    });
    const out = await executeActionJob(payload, h.deps());
    expect(out.outcome).toBe("published");
    const [revised] = await db.select().from(comments).where(eq(comments.id, h.commentId));
    expect(revised?.revision).toBe(2);
    // The generation request carried the challenge, quoted.
    expect(h.gen.requests[0]?.context.revisionReason).toContain("Nisam siguran");
  });
});

describe("executeActionJob: repair and quarantine", () => {
  it("repairs an English draft once, then publishes the Serbian one", async () => {
    const h = await jobHarness(db);
    h.gen.script = (request) => {
      const base = {
        script: "Latin" as const,
        evidenceIds: [],
        usage: {
          inputTokens: 10,
          outputTokens: 10,
          reasoningTokens: 0,
          cachedInputTokens: 0,
          estimatedCostUsd: 0,
        },
        provider: "mock",
        model: "mock-deterministic-v1",
      } satisfies Partial<GenerationResult>;
      return { ...base, body: request.repair ? SERBIAN_COMMENT : ENGLISH_COMMENT };
    };
    const payload = await replyPayload(h);
    const out = await executeActionJob(payload, h.deps());
    expect(out.outcome).toBe("published");
    expect(h.gen.requests).toHaveLength(2);
    expect(h.gen.requests[1]?.repair?.codes.length).toBeGreaterThan(0);
    const purposes = (
      await db.select({ purpose: providerRequests.purpose }).from(providerRequests)
    )
      .map((r) => r.purpose)
      .sort();
    expect(purposes).toEqual(["generation", "repair", "validation"]);
  });

  it("quarantines when the repair is still wrong, and never repairs twice", async () => {
    const h = await jobHarness(db);
    h.gen.script = () => ({
      body: ENGLISH_COMMENT,
      script: "Latin",
      evidenceIds: [],
      usage: {
        inputTokens: 10,
        outputTokens: 10,
        reasoningTokens: 0,
        cachedInputTokens: 0,
        estimatedCostUsd: 0,
      },
      provider: "mock",
      model: "mock-deterministic-v1",
    });
    const payload = await replyPayload(h);
    const out = await executeActionJob(payload, h.deps());
    expect(out.outcome).toBe("quarantined");
    expect(out.code).toBeTruthy();
    expect(h.gen.requests).toHaveLength(2);
    expect((await decisionOf(payload.decisionId)).outcome).toBe("quarantined");
  });

  it("quarantines an invented citation, and the repair cannot cite more", async () => {
    const h = await jobHarness(db);
    h.gen.script = () => ({
      body: SERBIAN_COMMENT,
      script: "Latin",
      evidenceIds: ["00000000-0000-4000-8000-0000000000aa"],
      usage: {
        inputTokens: 10,
        outputTokens: 10,
        reasoningTokens: 0,
        cachedInputTokens: 0,
        estimatedCostUsd: 0,
      },
      provider: "mock",
      model: "mock-deterministic-v1",
    });
    const payload = await replyPayload(h);
    const out = await executeActionJob(payload, h.deps());
    expect(out.outcome).toBe("quarantined");
    expect(out.code).toContain("invented_citation");
  });

  it("a validator rejection quarantines without a repair call", async () => {
    const h = await jobHarness(db);
    h.val.reject = true;
    const payload = await replyPayload(h);
    const out = await executeActionJob(payload, h.deps());
    expect(out.outcome).toBe("quarantined");
    expect(h.gen.requests).toHaveLength(1);
  });
});

describe("executeActionJob: budget and failures", () => {
  it("skips with the budget reason when the daily limit is spent", async () => {
    // Too small for one call, but the stage reads normal, so the gateway does the refusing.
    const config = jobsConfig((c) => {
      c.budget.dailyVariableSpendLimit = 0.0001;
    });
    const h = await jobHarness(db, { config, prices: SIMULATION_PRICE_TABLE });
    const payload = await replyPayload(h);
    const out = await executeActionJob(payload, h.deps());
    expect(out).toMatchObject({ outcome: "skipped", code: "budget_budget_exhausted" });
  });

  it("marks a non-retryable provider failure as failed", async () => {
    const h = await jobHarness(db);
    h.gen.script = () => {
      throw new ProviderCallError("bad request", "not_billed", false, { code: "400" });
    };
    const payload = await replyPayload(h);
    const out = await executeActionJob(payload, h.deps());
    expect(out).toMatchObject({ outcome: "failed", code: "provider_400" });
  });

  it("retries a retryable provider error with backoff, then dead-letters", async () => {
    const h = await jobHarness(db);
    h.gen.script = () => {
      throw new ProviderCallError("overloaded", "not_billed", true, { status: 503 });
    };
    const payload = await replyPayload(h);
    const queue = new MemoryJobQueue(() => 0);
    const options = jobOptionsFor("reply", h.config, payload.actionKey, h.clock.now());
    expect(options.retryLimit).toBe(2);
    await queue.send("reply", payload, options);

    const attempts: { attempt: number; at: number }[] = [];
    await queue.runDue(
      new Date(h.clock.now().getTime() + 3600_000),
      async (job, attempt) => {
        attempts.push({ attempt, at: h.clock.now().getTime() });
        await executeActionJob(job.payload, h.deps({ attempt }));
      },
      {
        setClock: (date) => h.clock.set(date),
        onDeadLetter: (job, error) =>
          recordDeadLetter(db, h.clock, job.payload, (error as Error).message),
      },
    );

    expect(attempts.map((a) => a.attempt)).toEqual([1, 2, 3]);
    // With no jitter, 30 s then 60 s: the pg-boss formula for retryDelay 30.
    expect((attempts[1]?.at ?? 0) - (attempts[0]?.at ?? 0)).toBe(30_000);
    expect((attempts[2]?.at ?? 0) - (attempts[1]?.at ?? 0)).toBe(60_000);
    expect(queue.stats()).toMatchObject({ sent: 1, retries: 2, deadLetters: 1, completed: 0 });
    const decision = await decisionOf(payload.decisionId);
    expect(decision).toMatchObject({ outcome: "failed", outcomeCode: "dead_letter" });
  });

  it("dead-lettering closes a proposed action row but leaves a published one alone", async () => {
    const h = await jobHarness(db);
    const payload = await replyPayload(h);
    await db.insert(agentActions).values({
      actionKey: payload.actionKey,
      actionType: "reply",
      status: "proposed",
      payload: {},
    });
    await recordDeadLetter(db, h.clock, payload, "boom");
    const [action] = await db
      .select()
      .from(agentActions)
      .where(eq(agentActions.actionKey, payload.actionKey));
    expect(action).toMatchObject({ status: "failed", error: "boom" });
    expect((await decisionOf(payload.decisionId)).outcomeCode).toBe("dead_letter");
  });
});

describe("tick to job", () => {
  it("runs the real scheduler and publishes what it plans", async () => {
    const h = await jobHarness(db, {
      config: jobsConfig((c) => {
        c.scheduler.jitterSeconds = 0;
      }),
    });
    const queue = new MemoryJobQueue();
    for (let minute = 0; minute < 40; minute += 1) {
      h.clock.advance(60_000);
      await runSchedulerTick({ db, config: h.config, clock: h.clock, queue });
      await queue.runDue(
        h.clock.now(),
        (job, attempt) => {
          return executeActionJob(job.payload, h.deps({ attempt }));
        },
        {
          setClock: (date) => h.clock.set(date),
          onDeadLetter: (job, error) =>
            recordDeadLetter(db, h.clock, job.payload, (error as Error).message),
        },
      );
    }
    const decisions = await db.select().from(schedulerDecisions);
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.every((d) => d.outcome !== "queued")).toBe(true);
    const published = decisions.filter((d) => d.outcome === "published");
    expect(published.length).toBeGreaterThan(0);
    const contentDecision = published.find((d) => d.actionId !== null);
    if (contentDecision) {
      const [action] = await db
        .select()
        .from(agentActions)
        .where(eq(agentActions.id, contentDecision.actionId ?? ""));
      expect(action?.status).toBe("published");
    }
    expect(queue.stats().deadLetters).toBe(0);
  }, 120_000);
});

describe("executeActionJob: transient validator failures", () => {
  it("rethrows, keeps the proposed row, and reuses the stored draft on retry", async () => {
    const h = await jobHarness(db);
    h.val.failWith = new BudgetRefusedError("busy", "Too many paid calls in flight.");
    const payload = await replyPayload(h);
    await expect(executeActionJob(payload, h.deps())).rejects.toBeInstanceOf(
      BudgetRefusedError,
    );

    const [action] = await db
      .select()
      .from(agentActions)
      .where(eq(agentActions.actionKey, payload.actionKey));
    expect(action?.status).toBe("proposed");
    expect(typeof action?.payload.body).toBe("string");
    expect((await decisionOf(payload.decisionId)).outcome).toBe("queued");
    expect(h.gen.requests).toHaveLength(1);

    h.val.failWith = null;
    const out = await executeActionJob(payload, h.deps({ attempt: 2 }));
    expect(out.outcome).toBe("published");
    // No second generation and no repair: the stored draft went straight back to the gate.
    expect(h.gen.requests).toHaveLength(1);
    const comment = await db
      .select()
      .from(comments)
      .where(eq(comments.id, out.resultId ?? ""));
    expect(comment[0]?.body).toBe(action?.payload.body);
  });

  it("still quarantines when the validator is not configured", async () => {
    const h = await jobHarness(db);
    h.val.failWith = new ProviderNotConfiguredError("validation");
    const out = await executeActionJob(await replyPayload(h), h.deps());
    expect(out.outcome).toBe("quarantined");
    expect(out.code).toContain("validator_not_configured");
  });

  it("still quarantines on a non-retryable validator error", async () => {
    const h = await jobHarness(db);
    h.val.failWith = new ProviderCallError("bad", "not_billed", false, { code: "400" });
    const out = await executeActionJob(await replyPayload(h), h.deps());
    expect(out.outcome).toBe("quarantined");
    expect(out.code).toContain("validator_unavailable");
  });
});

describe("executeActionJob: repair limit and re-checks", () => {
  const usage = {
    inputTokens: 10,
    outputTokens: 10,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    estimatedCostUsd: 0,
  };

  it("does not repair again when a repair request already exists for the key", async () => {
    const h = await jobHarness(db);
    h.gen.script = () => ({
      body: ENGLISH_COMMENT,
      script: "Latin",
      evidenceIds: [],
      usage,
      provider: "mock",
      model: "mock-deterministic-v1",
    });
    const payload = await replyPayload(h);
    await db.insert(providerRequests).values({
      actionKey: payload.actionKey,
      purpose: "repair",
      origin: "simulation",
      provider: "mock",
      model: "mock-deterministic-v1",
      status: "succeeded",
      estimatedInputTokens: 0,
      maxOutputTokens: 0,
      estimatedMicros: 0,
    });
    const out = await executeActionJob(payload, h.deps());
    expect(out.outcome).toBe("quarantined");
    expect(h.gen.requests).toHaveLength(1);
    expect(h.gen.requests[0]?.repair).toBeUndefined();
  });

  it("skips a revision whose challenging reply was hidden", async () => {
    const h = await jobHarness(db);
    const challenge = await addComment(
      {
        actor: h.people.personaA,
        actionKey: "fx:challenge2",
        threadId: h.threadId,
        parentCommentId: h.commentId,
        body: "Nisam siguran da je to tačno; imate li izvor za tu tvrdnju o toploti i ukusu ajvara?",
        intent: "disagree",
      },
      h.deps().buildContext(h.config),
    );
    if (challenge.status !== "published") throw new Error("challenge not published");
    await moderateContent(
      {
        actor: SYSTEM_ACTOR,
        targetType: "comment",
        targetId: challenge.id,
        action: "hide",
        explanation: "Sakriveno zbog kršenja pravila foruma.",
      },
      h.deps().buildContext(h.config),
    );
    const payload = await h.plan("revision", {
      personaId: h.people.personaBId,
      targetType: "comment",
      targetId: h.commentId,
      relatedCommentId: challenge.id,
      intent: "correct_earlier",
      contentVersion: { targetRevision: 1 },
    });
    const out = await executeActionJob(payload, h.deps());
    expect(out).toMatchObject({ outcome: "skipped", code: "content_changed" });
    expect(h.gen.requests).toHaveLength(0);
  });

  it("skips paid work when the stage is paused, but not votes", async () => {
    const h = await jobHarness(db, {
      config: jobsConfig((c) => {
        c.budget.dailyVariableSpendLimit = 0;
      }),
    });
    const out = await executeActionJob(await replyPayload(h), h.deps());
    expect(out).toMatchObject({ outcome: "skipped", code: "budget_paused" });
    const vote = await h.plan("vote", {
      personaId: h.people.personaAId,
      targetType: "comment",
      targetId: h.commentId,
      voteValue: 1,
    });
    expect((await executeActionJob(vote, h.deps())).outcome).toBe("published");
  });
});
