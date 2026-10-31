import { describe, expect, it } from "vitest";
import { STANDARD_PRESET } from "@/lib/config/presets";
import type { AgoraConfig } from "@/lib/config/schema";
import { belgradeHour } from "@/lib/time";
import { SeededRandom } from "@/lib/random";
import {
  finalizeIntent,
  replyCandidates,
  voteValueFor,
  type Candidate,
} from "@/lib/scheduler/candidates";
import {
  globalReason,
  isWithinActiveHours,
  pairChainLength,
  personaReason,
  replyReason,
  revisionReason,
  threadReason,
  voteCapPerPersona,
  voteReason,
} from "@/lib/scheduler/eligibility";
import {
  applyTickCap,
  burstLimit,
  dayWeightSum,
  drawSlots,
  emptyCounts,
  expectedSlots,
  hourlyExpected,
  hourWeight,
  planSlots,
} from "@/lib/scheduler/pacing";
import { chooseAmong, scoreCandidates, scoreFeatures } from "@/lib/scheduler/scoring";
import {
  applyPick,
  usageOf,
  type PersonaInfo,
  type SchedulerSnapshot,
  type SnapshotComment,
  type SnapshotThread,
} from "@/lib/scheduler/snapshot";
import { IDLE_SCORE, WEIGHTS } from "@/lib/scheduler/weights";

const config = (): AgoraConfig => structuredClone(STANDARD_PRESET);
const NOW = new Date("2026-09-10T08:00:00Z"); // 10:00 in Belgrade (CEST)

function persona(id: string, over: Partial<PersonaInfo> = {}): PersonaInfo {
  return {
    id,
    displayName: id,
    interests: ["kuhinja", "zimnica"],
    limits: {
      maxContentActionsPerDay: 12,
      replyCooldownMinutes: 10,
      activeHours: { from: 7, to: 23 },
    },
    isSuspended: false,
    affinity: new Map([["c1", 4]]),
    ...over,
  };
}

function thread(id: string, over: Partial<SnapshotThread> = {}): SnapshotThread {
  return {
    id,
    communityId: "c1",
    title: "Naslov",
    authorPersonaId: "author",
    commentCount: 3,
    createdAt: new Date(NOW.getTime() - 5 * 3_600_000),
    lastActivityAt: new Date(NOW.getTime() - 3_600_000),
    revision: 1,
    score: 0,
    isQuestion: false,
    hasFreshEvidence: false,
    commentsLast24h: 3,
    summaryCovers: 0,
    ...over,
  };
}

function comment(
  id: string,
  authorPersonaId: string,
  over: Partial<SnapshotComment> = {},
): SnapshotComment {
  return {
    id,
    threadId: "t1",
    parentCommentId: null,
    authorPersonaId,
    depth: 0,
    createdAt: new Date(NOW.getTime() - 2 * 3_600_000),
    updatedAt: new Date(NOW.getTime() - 2 * 3_600_000),
    replyCount: 0,
    revision: 1,
    score: 0,
    isQuestion: false,
    intent: null,
    ...over,
  };
}

function snapshot(over: Partial<SchedulerSnapshot> = {}): SchedulerSnapshot {
  const personas = over.personas ?? [persona("A"), persona("B")];
  const threads = over.threads ?? [thread("t1")];
  const comments = over.comments ?? [];
  return {
    now: NOW,
    hour: belgradeHour(NOW),
    dayStart: new Date("2026-09-09T22:00:00Z"),
    personas,
    activePersonaCount: personas.filter((p) => !p.isSuspended).length,
    communities: new Map([["c1", { id: "c1", isActive: true, newestThreadAt: null }]]),
    threads,
    threadsById: new Map(threads.map((t) => [t.id, t])),
    comments,
    commentsById: new Map(comments.map((c) => [c.id, c])),
    usedToday: emptyCounts(),
    plannedLastHour: emptyCounts(),
    usage: new Map(),
    threadContributions: new Map(),
    personaThreadComments: new Map(),
    pairLast: new Map(),
    communityActivity: new Map(),
    communityActivityTotal: 0,
    votedTargets: new Set(),
    queuedReplyTargets: new Set(),
    queuedRevisionTargets: new Set(),
    queuedSummaryThreads: new Set(),
    sizes: {},
    ...over,
  };
}

describe("pacing", () => {
  const cfg = config();

  it("gives night hours 15 % of a day hour and day hours full weight", () => {
    expect(hourWeight(2, cfg.scheduler)).toBeCloseTo(0.15);
    expect(hourWeight(23, cfg.scheduler)).toBeCloseTo(0.15);
    expect(hourWeight(7, cfg.scheduler)).toBe(1);
    expect(hourWeight(22, cfg.scheduler)).toBe(1);
    expect(dayWeightSum(cfg.scheduler)).toBeCloseTo(16 + 8 * 0.15);
  });

  it("spreads the daily maximum so that a day's hours add up to it", () => {
    let total = 0;
    for (let h = 0; h < 24; h += 1) total += hourlyExpected(120, h, cfg.scheduler);
    expect(total).toBeCloseTo(120);
    // One 60 s tick is a sixtieth of the hour; a night tick expects 15 % of a day tick.
    const day = expectedSlots(120, 12, cfg.scheduler, 60);
    const night = expectedSlots(120, 3, cfg.scheduler, 60);
    expect(night / day).toBeCloseTo(0.15);
    expect(day).toBeCloseTo(120 / dayWeightSum(cfg.scheduler) / 60);
  });

  it("draws floor(expected) plus one with probability frac, deterministically per seed", () => {
    const a = Array.from({ length: 20 }, (_, i) => drawSlots(2.4, new SeededRandom(`s${i}`)));
    const b = Array.from({ length: 20 }, (_, i) => drawSlots(2.4, new SeededRandom(`s${i}`)));
    expect(a).toEqual(b);
    expect(a.every((n) => n === 2 || n === 3)).toBe(true);
    expect(a).toContain(2);
    expect(a).toContain(3);
    const mean =
      Array.from({ length: 4000 }, (_, i) => drawSlots(0.3, new SeededRandom(`m${i}`))).reduce(
        (x, y) => x + y,
        0,
      ) / 4000;
    expect(mean).toBeGreaterThan(0.25);
    expect(mean).toBeLessThan(0.35);
  });

  const baseInput = () => ({
    hour: 12,
    scheduler: cfg.scheduler,
    content: { ...cfg.content, maxNewCommentsPerDay: 5000, maxVotesPerDay: 5000 },
    periodSec: 60,
    usedToday: emptyCounts(),
    plannedLastHour: emptyCounts(),
    dueSummaries: 0,
    maxActionsPerTick: 10,
    seed: "x",
  });

  it("never plans more than what is left of the day", () => {
    const input = baseInput();
    input.usedToday.reply = 4999;
    // Seeds for which the unconstrained draw would be >= 2.
    for (let i = 0; i < 50; i += 1) {
      expect(planSlots({ ...input, seed: `seed${i}` }).reply.drawn).toBeLessThanOrEqual(1);
    }
    input.usedToday.reply = 5000;
    expect(planSlots(input).reply.drawn).toBe(0);
  });

  it("applies the burst guard against the last hour", () => {
    const hourly = hourlyExpected(5000, 12, cfg.scheduler);
    expect(burstLimit(hourly, 0)).toBe(Math.ceil(2 * hourly + 1));
    expect(burstLimit(hourly, 10_000)).toBe(0);
    const input = baseInput();
    input.plannedLastHour.reply = Math.ceil(2 * hourly + 1);
    expect(planSlots(input).reply.drawn).toBe(0);
  });

  it("drops votes first, then revisions, threads, replies and summaries last", () => {
    const all = { thread: 1, reply: 2, revision: 1, summary: 1, vote: 3 };
    expect(applyTickCap(all, 3)).toEqual({
      thread: 0,
      reply: 2,
      revision: 0,
      summary: 1,
      vote: 0,
    });
    expect(applyTickCap(all, 5)).toEqual({
      thread: 1,
      reply: 2,
      revision: 1,
      summary: 1,
      vote: 0,
    });
    expect(applyTickCap(all, 1)).toEqual({
      thread: 0,
      reply: 0,
      revision: 0,
      summary: 1,
      vote: 0,
    });
    expect(applyTickCap(all, 20)).toEqual(all);
  });

  it("plans at most one summary per tick, inside the daily summary maximum", () => {
    const input = baseInput();
    input.dueSummaries = 4;
    expect(planSlots(input).summary.drawn).toBe(1);
    input.usedToday.summary = cfg.content.maxSummariesPerDay;
    expect(planSlots(input).summary.drawn).toBe(0);
  });

  it("is identical for identical inputs and ignores any notion of missed time", () => {
    const input = baseInput();
    expect(planSlots(input)).toEqual(planSlots({ ...input }));
  });
});

describe("eligibility", () => {
  const cfg = config();

  it("handles active hours with and without wrapping", () => {
    expect(isWithinActiveHours(10, 7, 23)).toBe(true);
    expect(isWithinActiveHours(7, 7, 23)).toBe(true);
    expect(isWithinActiveHours(23, 7, 23)).toBe(false);
    expect(isWithinActiveHours(3, 7, 23)).toBe(false);
    expect(isWithinActiveHours(23, 20, 4)).toBe(true);
    expect(isWithinActiveHours(2, 20, 4)).toBe(true);
    expect(isWithinActiveHours(4, 20, 4)).toBe(false);
    expect(isWithinActiveHours(12, 20, 4)).toBe(false);
  });

  it("counts the alternating pair chain (limit 4 blocks, limit 5 allows)", () => {
    // A -> B -> A -> B, B newest.
    const c1 = comment("c1", "A");
    const c2 = comment("c2", "B", { parentCommentId: "c1", depth: 1 });
    const c3 = comment("c3", "A", { parentCommentId: "c2", depth: 2 });
    const c4 = comment("c4", "B", { parentCommentId: "c3", depth: 3 });
    const all = new Map([c1, c2, c3, c4].map((c) => [c.id, c]));
    expect(pairChainLength(c4, "A", (id) => all.get(id))).toBe(4);
    // C replying to B's newest comment: chain B, (A is not C) stops after 1.
    expect(pairChainLength(c4, "C", (id) => all.get(id))).toBe(1);

    const run = (max: number) => {
      const cf = config();
      cf.personas.maxConsecutivePairReplies = max;
      const s = snapshot({
        comments: [c4, c3, c2, c1],
        threads: [thread("t1")],
        personas: [persona("A"), persona("B")],
      });
      const a = s.personas[0]!;
      return replyReason(s, cf, a, { type: "comment", thread: s.threads[0]!, comment: c4 });
    };
    expect(run(4)).toBe("pair_chain");
    expect(run(5)).toBeNull();
  });

  it("reports why a persona is out", () => {
    const s = snapshot();
    const p = persona("A");
    expect(personaReason(s, cfg, p, "reply")).toBeNull();
    expect(personaReason(s, cfg, persona("A", { isSuspended: true }), "reply")).toBe(
      "persona_suspended",
    );
    expect(
      personaReason(
        s,
        cfg,
        persona("A", { limits: { ...p.limits, activeHours: { from: 12, to: 20 } } }),
        "reply",
      ),
    ).toBe("outside_active_hours");

    usageOf(s, "A").contentToday = 12;
    expect(personaReason(s, cfg, p, "reply")).toBe("persona_daily_cap");
    expect(personaReason(s, cfg, p, "vote")).toBeNull();

    // The lower of the persona's own cap and the global per-persona cap wins.
    const low = config();
    low.personas.maxContentActionsPerPersonaPerDay = 2;
    usageOf(s, "A").contentToday = 2;
    expect(personaReason(s, low, p, "thread")).toBe("persona_daily_cap");
  });

  it("enforces the larger of the persona and the global reply cooldown", () => {
    const s = snapshot();
    const p = persona("A"); // own cooldown 10 min
    const cf = config();
    cf.personas.minimumReplyCooldownMinutes = 20;
    usageOf(s, "A").lastContentAt = new Date(NOW.getTime() - 15 * 60_000);
    expect(personaReason(s, cf, p, "reply")).toBe("cooldown");
    expect(personaReason(s, cf, p, "revision")).toBeNull(); // revisions have no cooldown
    usageOf(s, "A").lastContentAt = new Date(NOW.getTime() - 21 * 60_000);
    expect(personaReason(s, cf, p, "reply")).toBeNull();
  });

  it("limits votes per persona to twice the even share of the daily maximum", () => {
    expect(voteCapPerPersona(300, 16)).toBe(38);
    const s = snapshot();
    usageOf(s, "A").votesToday = voteCapPerPersona(cfg.content.maxVotesPerDay, 2);
    expect(personaReason(s, cfg, persona("A"), "vote")).toBe("persona_vote_cap");
  });

  it("stops at the global daily maximum of a kind", () => {
    const s = snapshot();
    s.usedToday.thread = cfg.content.maxNewThreadsPerDay;
    expect(globalReason(s, cfg, "thread")).toBe("global_daily_cap");
    expect(globalReason(s, cfg, "reply")).toBeNull();
  });

  it("filters reply targets: membership, own comment, depth, pair cooldown, contributions", () => {
    const own = comment("own", "A");
    const other = comment("other", "B", { depth: cfg.content.maxCommentDepth - 1 });
    const fresh = comment("fresh", "B");
    const s = snapshot({ comments: [own, other, fresh] });
    const a = s.personas[0]!;
    const t = s.threads[0]!;
    const target = (c: SnapshotComment) => ({
      type: "comment" as const,
      thread: t,
      comment: c,
    });

    expect(
      replyReason(s, cfg, persona("Z", { affinity: new Map() }), { type: "thread", thread: t }),
    ).toBe("not_member");
    expect(replyReason(s, cfg, a, target(own))).toBe("own_comment");
    expect(replyReason(s, cfg, a, target(other))).toBe("depth_limit");
    expect(replyReason(s, cfg, a, target(fresh))).toBeNull();

    s.pairLast.set("A:B", new Date(NOW.getTime() - 10 * 60_000));
    expect(replyReason(s, cfg, a, target(fresh))).toBe("pair_cooldown");
    s.pairLast.set("A:B", new Date(NOW.getTime() - 31 * 60_000));
    expect(replyReason(s, cfg, a, target(fresh))).toBeNull();

    s.threadContributions.set("A:t1", cfg.scheduler.maxThreadContributionsPerPersonaPerDay);
    expect(replyReason(s, cfg, a, target(fresh))).toBe("thread_contribution_cap");
    expect(replyReason(s, cfg, a, { type: "thread", thread: t })).toBe(
      "thread_contribution_cap",
    );

    s.threadContributions.clear();
    s.queuedReplyTargets.add("fresh");
    expect(replyReason(s, cfg, a, target(fresh))).toBe("reply_in_flight");
  });

  it("filters thread, revision and vote candidates", () => {
    const s = snapshot();
    const low = persona("L", { affinity: new Map([["c1", 1]]) });
    expect(threadReason(s, low, "c1")).toBe("low_affinity");
    expect(threadReason(s, persona("A"), "c1")).toBeNull();
    expect(threadReason(s, persona("A"), "other")).toBe("not_member");

    const mine = comment("m", "A", { revision: 1 });
    expect(revisionReason(s, persona("A"), mine)).toBeNull();
    expect(revisionReason(s, persona("B"), mine)).toBe("not_author");
    expect(revisionReason(s, persona("A"), comment("m3", "A", { revision: 3 }))).toBe(
      "revision_limit",
    );
    s.queuedRevisionTargets.add("m");
    expect(revisionReason(s, persona("A"), mine)).toBe("revision_in_flight");

    const target = { id: "x", authorPersonaId: "B", communityId: "c1" };
    expect(voteReason(s, persona("A"), target)).toBeNull();
    expect(voteReason(s, persona("B"), target)).toBe("own_content");
    s.votedTargets.add("A:x");
    expect(voteReason(s, persona("A"), target)).toBe("already_voted");
    expect(voteReason(s, low, { ...target, id: "y" })).toBe("low_affinity");
  });
});

describe("scoring", () => {
  const flags = { affinity: 4, freshEvidence: false, answersOpenQuestion: true };

  it("records every feature and the breakdown sums to the total", () => {
    const values = {
      unansweredQuestion: 1,
      freshEvidence: 0,
      personaRelevance: 0.8,
      topicDiversity: -0.25,
      threadSaturation: -0.15,
      threadRecency: 0.9,
      personaThreadShare: -0.1,
    };
    const b = scoreFeatures("reply", values, "normal", flags);
    expect(b.features.map((f) => f.key)).toEqual(Object.keys(WEIGHTS.reply));
    const sum = b.base + b.features.reduce((acc, f) => acc + f.contribution, 0);
    expect(b.total).toBeCloseTo(sum);
    for (const f of b.features) expect(f.contribution).toBeCloseTo(f.weight * f.value);
    expect(b.features[0]?.label).toBe("Neodgovoreno pitanje");
  });

  it("multiplies by the stage factor and floors the sum at zero", () => {
    const values = { unansweredQuestion: 0, personaRelevance: 0.2, threadRecency: 0.1 };
    const normal = scoreFeatures("reply", values, "normal", {
      ...flags,
      answersOpenQuestion: false,
    });
    const reduced = scoreFeatures("reply", values, "reduced", {
      ...flags,
      answersOpenQuestion: false,
    });
    expect(reduced.stageFactor).toBe(0.6);
    expect(reduced.total).toBeCloseTo(normal.total * 0.6);
    const hostile = scoreFeatures(
      "reply",
      { topicDiversity: -1, threadSaturation: -1, personaThreadShare: -1 },
      "normal",
      flags,
    );
    expect(hostile.total).toBe(0);
  });

  const candidate = (
    key: string,
    values: Record<string, number>,
    over: Partial<Candidate> = {},
  ): Candidate => ({
    kind: "reply",
    personaId: "A",
    communityId: "c1",
    threadId: "t1",
    targetId: key,
    targetType: "comment",
    values,
    flags,
    voteValue: null,
    relatedCommentId: null,
    unanswered: false,
    topLevel: false,
    challengeIntent: null,
    contentVersion: {},
    sortKey: key,
    ...over,
  });

  it("removes candidates the stage factor zeroes", () => {
    const cands = [
      candidate(
        "a",
        { personaRelevance: 1 },
        { flags: { ...flags, answersOpenQuestion: false } },
      ),
    ];
    expect(scoreCandidates(cands, "normal")).toHaveLength(1);
    expect(scoreCandidates(cands, "minimal")).toHaveLength(0); // not an open question
    expect(scoreCandidates(cands, "paused")).toHaveLength(0);
  });

  it("ranks by score, then by key, and the same inputs choose the same candidate", () => {
    const ranked = scoreCandidates(
      [
        candidate("b", { personaRelevance: 1 }),
        candidate("a", { personaRelevance: 1 }),
        candidate("c", {}),
      ],
      "normal",
    );
    expect(ranked.map((c) => c.sortKey)).toEqual(["a", "b", "c"]);
    const pick = (seed: string) =>
      chooseAmong(ranked, new SeededRandom(seed)).chosen?.sortKey ?? "idle";
    expect(pick("seed-1")).toBe(pick("seed-1"));
  });

  it("lets idle win sometimes, with probabilities that sum to one", () => {
    const ranked = scoreCandidates([candidate("a", {})], "normal"); // score = base = 1
    const outcomes = Array.from({ length: 400 }, (_, i) =>
      chooseAmong(ranked, new SeededRandom(`i${i}`)),
    );
    const idle = outcomes.filter((o) => o.chosen === null);
    expect(idle.length).toBeGreaterThan(100);
    expect(idle.length).toBeLessThan(300);
    const first = outcomes.find((o) => o.chosen)!;
    expect(first.probability).toBeCloseTo(1 / (1 + IDLE_SCORE));
    expect(idle[0]?.probability).toBeCloseTo(IDLE_SCORE / (1 + IDLE_SCORE));
    expect(chooseAmong([], new SeededRandom("e")).chosen).toBeNull();
  });
});

describe("candidates", () => {
  const cfg = config();

  it("spreads opinion deterministically: -1 only on targets already scoring 3 or more", () => {
    for (let i = 0; i < 30; i += 1) expect(voteValueFor(`p${i}`, "t", 2)).toBe(1);
    const values = Array.from({ length: 400 }, (_, i) => voteValueFor(`p${i}`, "t", 5));
    const negative = values.filter((v) => v === -1).length;
    expect(negative).toBeGreaterThan(30);
    expect(negative).toBeLessThan(90);
    expect(voteValueFor("p1", "t", 5)).toBe(voteValueFor("p1", "t", 5));
  });

  it("flags unanswered questions and honours the budget in reply candidates", () => {
    const q = comment("q", "B", { isQuestion: true });
    const s = snapshot({ comments: [q], threads: [thread("t1")] });
    const out = replyCandidates(s, cfg).filter(
      (c) => c.personaId === "A" && c.targetId === "q",
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.unanswered).toBe(true);
    expect(out[0]?.values.unansweredQuestion).toBe(1);
    expect(out[0]?.flags.answersOpenQuestion).toBe(true);
    // Answered questions are no longer unanswered.
    q.replyCount = 1;
    const again = replyCandidates(s, cfg).find(
      (c) => c.personaId === "A" && c.targetId === "q",
    );
    expect(again?.unanswered).toBe(false);
  });

  it("picks intents from the plan, seeded", () => {
    const base = { unanswered: false, topLevel: false } as Candidate;
    expect(
      finalizeIntent(
        { ...base, kind: "reply", unanswered: true } as Candidate,
        null,
        new SeededRandom("x"),
      ).intent,
    ).toBe("answer_question");
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      seen.add(
        finalizeIntent({ ...base, kind: "reply" } as Candidate, null, new SeededRandom(`r${i}`))
          .intent ?? "",
      );
    }
    expect([...seen].sort()).toEqual(["add_context", "alternative_interpretation", "disagree"]);
    const top = finalizeIntent(
      { ...base, kind: "reply", topLevel: true } as Candidate,
      null,
      new SeededRandom("t"),
    );
    expect(["ask_question", "add_context"]).toContain(top.intent);
    const thr = finalizeIntent(
      { ...base, kind: "thread" } as Candidate,
      persona("A"),
      new SeededRandom("th"),
    );
    expect(["introduce_topic", "ask_question"]).toContain(thr.intent);
    expect(["kuhinja", "zimnica"]).toContain(thr.topicHint);
    expect(
      finalizeIntent({ ...base, kind: "vote" } as Candidate, null, new SeededRandom("v"))
        .intent,
    ).toBeNull();
    expect(
      finalizeIntent({ ...base, kind: "summary" } as Candidate, null, new SeededRandom("v"))
        .intent,
    ).toBe("summarize");
  });

  it("updates the snapshot after a pick so later slots honour the limits", () => {
    const q = comment("q", "B", { isQuestion: true });
    const s = snapshot({ comments: [q] });
    applyPick(s, {
      kind: "reply",
      personaId: "A",
      communityId: "c1",
      threadId: "t1",
      targetId: "q",
      targetType: "comment",
    });
    expect(usageOf(s, "A").contentToday).toBe(1);
    expect(usageOf(s, "A").lastContentAt).toEqual(NOW);
    expect(s.threadContributions.get("A:t1")).toBe(1);
    expect(s.usedToday.reply).toBe(1);
    expect(s.pairLast.get("A:B")).toEqual(NOW);
    expect(s.communityActivityTotal).toBe(1);
    expect(q.replyCount).toBe(1);
    // The same persona is now in cooldown, and the comment is spoken for.
    expect(personaReason(s, cfg, s.personas[0]!, "reply")).toBe("cooldown");
    expect(
      replyReason(s, cfg, s.personas[1]!, {
        type: "comment",
        thread: s.threads[0]!,
        comment: q,
      }),
    ).toBe("reply_in_flight");
    expect(
      replyReason(s, cfg, persona("C"), { type: "comment", thread: s.threads[0]!, comment: q }),
    ).toBe("reply_in_flight");
  });
});
