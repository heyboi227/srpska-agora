import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { STANDARD_PRESET } from "@/lib/config/presets";
import type { AgoraConfig } from "@/lib/config/schema";
import { ManualClock } from "@/lib/clock";
import type { Db } from "@/lib/db/client";
import {
  comments,
  personas,
  schedulerDecisions,
  schedulerRuns,
  threads,
} from "@/lib/db/schema";
import { SYSTEM_ACTOR, type Actor } from "@/lib/domain/actors";
import { addComment } from "@/lib/domain/comments";
import { createCommunity } from "@/lib/domain/communities";
import type { ServiceContext } from "@/lib/domain/context";
import { createPersona } from "@/lib/domain/personas";
import { createThread } from "@/lib/domain/threads";
import type { ActionJobPayload, ActionKind, JobQueue, JobSendOptions } from "@/lib/jobs/types";
import { createProviders } from "@/lib/providers";
import { previewSchedulerTick, runSchedulerTick } from "@/lib/scheduler";
import { pairChainLength } from "@/lib/scheduler/eligibility";
import { hourlyExpected } from "@/lib/scheduler/pacing";
import { testDb } from "./helpers";

// 10:00 in Belgrade (CEST) on a Thursday.
const DAY = new Date("2026-09-10T08:00:00Z");
// 02:00 the same morning.
const NIGHT = new Date("2026-09-10T00:00:00Z");
const MINUTE = 60_000;

class FakeQueue implements JobQueue {
  sends: { kind: ActionKind; payload: ActionJobPayload; options: JobSendOptions }[] = [];
  pending = 0;
  mode: "ok" | "duplicate" | "throw" = "ok";
  async send(kind: ActionKind, payload: ActionJobPayload, options: JobSendOptions) {
    if (this.mode === "throw") throw new Error("boom");
    if (this.mode === "duplicate") return null;
    this.sends.push({ kind, payload, options });
    return `job-${this.sends.length}`;
  }
  async pendingCount() {
    return this.pending;
  }
}

/** Generous daily maxima so pacing, not the daily limits, shapes what a few minutes of ticks plan. */
function schedulerConfig(over: (c: AgoraConfig) => void = () => {}): AgoraConfig {
  const config = structuredClone(STANDARD_PRESET);
  config.content.maxNewThreadsPerDay = 50;
  config.content.maxNewCommentsPerDay = 500;
  config.content.maxRevisionsPerDay = 50;
  config.content.maxVotesPerDay = 1000;
  config.content.maxCommentDepth = 8;
  config.personas.maxContentActionsPerPersonaPerDay = 50;
  config.runtime.maxPendingJobs = 1000;
  over(config);
  return config;
}

interface Forum {
  ctx: ServiceContext;
  clock: ManualClock;
  actors: Record<string, Actor & { kind: "persona" }>;
  ids: Record<string, string>;
  threadIds: { kuhinja: string; mediji: string; sport: string };
}

const LIMITS = {
  maxContentActionsPerDay: 50,
  replyCooldownMinutes: 10,
  activeHours: { from: 0, to: 24 },
};

async function publishComment(
  forum: Forum,
  who: string,
  key: string,
  threadId: string,
  body: string,
  parentCommentId: string | null = null,
  intent?: Parameters<typeof addComment>[0]["intent"],
): Promise<string> {
  forum.clock.advance(MINUTE);
  const result = await addComment(
    {
      actor: forum.actors[who] as Actor,
      actionKey: `fx:${key}`,
      threadId,
      parentCommentId,
      body,
      intent,
    },
    forum.ctx,
  );
  if (result.status !== "published")
    throw new Error(`comment ${key}: ${JSON.stringify(result)}`);
  return result.id;
}

/**
 * Three communities, five personas with different affinities, three threads and
 * a few comments, all built through the real domain services at 05:00 Belgrade.
 */
async function buildForum(db: Db, limits = LIMITS): Promise<Forum> {
  const clock = new ManualClock(new Date("2026-09-10T03:00:00Z"));
  const config = schedulerConfig();
  const ctx: ServiceContext = {
    db,
    config,
    providers: createProviders("mock"),
    origin: "system",
    now: () => clock.now(),
  };
  const community = (slug: string, name: string, description: string) =>
    createCommunity(
      {
        actor: SYSTEM_ACTOR,
        slug,
        name,
        description,
        rules: "Bez uvreda. Navedite izvor kada tvrdite nešto.",
      },
      ctx,
    );
  await community("kuhinja", "Kuhinja", "Ajvar, sarma, pijace i recepti iz cele Srbije.");
  await community("mediji", "Mediji", "Vesti, izvori i provera tvrdnji u Srbiji.");
  await community("sport", "Sport", "Fudbal, košarka i rukomet u Srbiji.");

  const spec: [string, string, [string, number][]][] = [
    [
      "slavica",
      "Slavica iz Zrenjanina",
      [
        ["kuhinja", 5],
        ["mediji", 2],
      ],
    ],
    [
      "skeptik",
      "Skeptik sa izvorom",
      [
        ["mediji", 5],
        ["kuhinja", 3],
      ],
    ],
    [
      "navijac",
      "Navijač iz Novog Sada",
      [
        ["sport", 5],
        ["kuhinja", 2],
      ],
    ],
    [
      "domacin",
      "Domaćin iz Šumadije",
      [
        ["kuhinja", 4],
        ["sport", 3],
        ["mediji", 1],
      ],
    ],
    [
      "novinar",
      "Novinar sa terena",
      [
        ["mediji", 4],
        ["sport", 2],
        ["kuhinja", 1],
      ],
    ],
  ];
  const actors: Forum["actors"] = {};
  const ids: Forum["ids"] = {};
  for (const [slug, displayName, memberships] of spec) {
    const p = await createPersona(
      {
        actor: SYSTEM_ACTOR,
        slug,
        displayName,
        bio: "AI sagovornik koji prati dešavanja u Srbiji i voli smireni razgovor.",
        interests: ["zimnica", "vesti"],
        style: "Topao, praktičan ton, kratke rečenice.",
        scriptPreference: "Latin",
        vocabularyNotes: "Ekavica.",
        limits,
        memberships: memberships.map(([communitySlug, affinity]) => ({
          communitySlug,
          affinity,
        })),
      },
      ctx,
    );
    actors[slug] = { kind: "persona", personaId: p.id, accountId: p.accountId };
    ids[slug] = p.id;
  }

  const thread = async (who: string, communitySlug: string, title: string, body: string) => {
    clock.advance(MINUTE);
    const r = await createThread(
      {
        actor: actors[who] as Actor,
        actionKey: `fx:thread:${communitySlug}`,
        communitySlug,
        title,
        body,
      },
      ctx,
    );
    if (r.status !== "published")
      throw new Error(`thread ${communitySlug}: ${JSON.stringify(r)}`);
    return r.id;
  };
  const threadIds = {
    kuhinja: await thread(
      "slavica",
      "kuhinja",
      "Kako čuvate ajvar preko zime u Srbiji?",
      "Svake jeseni ista dilema: tegle od kile ili manje? Zanima me kako to radite u Vojvodini, a kako u Šumadiji. Moje iskustvo je da se ajvar najbolje drži u tamnoj ostavi.",
    ),
    mediji: await thread(
      "skeptik",
      "mediji",
      "Kome u Srbiji verujete kada čitate vesti o ceni struje?",
      "Poslednjih nedelja u Srbiji čitam različite vesti o ceni struje, a brojke se razlikuju od portala do portala. Zanima me kako vi proveravate izvor i datum pre nego što nešto podelite.",
    ),
    sport: await thread(
      "navijac",
      "sport",
      "Ko će ove sezone osvojiti titulu u Srbiji?",
      "Prvenstvo u Srbiji je počelo neočekivano, a nekoliko klubova iz Beograda i Novog Sada igra bolje nego prošle godine. Šta mislite, ko ima najviše šanse za titulu?",
    ),
  };
  const forum: Forum = { ctx, clock, actors, ids, threadIds };
  await publishComment(
    forum,
    "domacin",
    "c1",
    threadIds.kuhinja,
    "Ja ajvar čuvam u manjim teglama jer se tako brže potroši, a u Šumadiji komšije rade isto.",
  );
  await publishComment(
    forum,
    "skeptik",
    "c2",
    threadIds.sport,
    "Zanimljivo, ali ja bih sačekao još nekoliko kola pre nego što se opkladim na titulu u Srbiji.",
  );
  return forum;
}

function tickDeps(forum: Forum, queue: FakeQueue, config = forum.ctx.config) {
  return { db: forum.ctx.db, config, clock: forum.clock, queue };
}

/** Runs `count` ticks, a minute apart, starting at `start`. */
async function runTicks(
  forum: Forum,
  queue: FakeQueue,
  start: Date,
  count: number,
  config = forum.ctx.config,
) {
  forum.clock.set(start);
  const results = [];
  for (let i = 0; i < count; i += 1) {
    results.push(await runSchedulerTick(tickDeps(forum, queue, config)));
    forum.clock.advance(MINUTE);
  }
  return results;
}

const decisionsOf = (db: Db) => db.select().from(schedulerDecisions);

async function resetScheduler(db: Db) {
  await db.execute(sql`truncate table scheduler_decisions, scheduler_runs cascade`);
}

describe("scheduler tick", () => {
  it("plans decisions with breakdowns, records the run, and enqueues jobs with the action key", async () => {
    const db = testDb();
    const forum = await buildForum(db);
    const queue = new FakeQueue();
    const results = await runTicks(forum, queue, DAY, 30);

    const runs = await db.select().from(schedulerRuns);
    expect(runs).toHaveLength(30);
    const rows = await decisionsOf(db);
    expect(rows.length).toBeGreaterThan(5);
    expect(queue.sends).toHaveLength(rows.length);
    expect(results.flatMap((r) => r.decisions)).toHaveLength(rows.length);

    for (const row of rows) {
      expect(row.outcome).toBe("queued");
      expect(row.breakdown.features.length).toBeGreaterThan(0);
      const sum =
        row.breakdown.base + row.breakdown.features.reduce((a, f) => a + f.contribution, 0);
      expect(row.breakdown.total).toBeCloseTo(Math.max(0, sum) * row.breakdown.stageFactor);
      expect(row.score).toBeCloseTo(row.breakdown.total);
      expect(row.probability).toBeGreaterThan(0);
      expect(row.probability).toBeLessThanOrEqual(1);
      expect(row.actionKey).toMatch(/^sched:(thread|reply|revision|summary|vote):/);
      expect(row.jobId).toMatch(/^job-/);
      expect(row.notAfter.getTime() - row.createdAt.getTime()).toBe(
        forum.ctx.config.scheduler.jobFreshnessMinutes * MINUTE,
      );
    }
    for (const send of queue.sends) {
      expect(send.options.singletonKey).toBe(send.payload.actionKey);
      const planned = new Date(send.payload.plannedAt).getTime();
      const startAfter = send.options.startAfter.getTime();
      expect(startAfter).toBeGreaterThanOrEqual(planned);
      expect(startAfter).toBeLessThanOrEqual(
        planned + forum.ctx.config.scheduler.jitterSeconds * 1000,
      );
      expect(send.payload.decisionId).toMatch(/^[0-9a-f-]{36}$/);
    }
    // Votes carry a value; replies and threads carry an intent.
    expect(
      queue.sends.filter((s) => s.kind === "vote").every((s) => s.payload.voteValue !== null),
    ).toBe(true);
    expect(
      queue.sends
        .filter((s) => s.kind === "reply" || s.kind === "thread")
        .every((s) => s.payload.intent),
    ).toBe(true);

    const avg = runs.reduce((a, r) => a + (r.durationMs ?? 0), 0) / runs.length;
    console.log(
      `scheduler tick: ${runs.length} ticks, average ${avg.toFixed(1)} ms, max ${Math.max(...runs.map((r) => r.durationMs ?? 0))} ms`,
    );
  });

  it("plans far fewer actions at night than by day", async () => {
    const db = testDb();
    const forum = await buildForum(db);
    const night = await runTicks(forum, new FakeQueue(), NIGHT, 60);
    await resetScheduler(db);
    const day = await runTicks(forum, new FakeQueue(), DAY, 60);
    const count = (rs: typeof night) => rs.reduce((a, r) => a + r.decisions.length, 0);
    expect(count(day)).toBeGreaterThan(20);
    expect(count(night)).toBeLessThan(count(day) / 2);
  });

  it("skips a second tick inside the interval without writing a row", async () => {
    const db = testDb();
    const forum = await buildForum(db);
    const queue = new FakeQueue();
    forum.clock.set(DAY);
    const first = await runSchedulerTick(tickDeps(forum, queue));
    expect(first.runId).not.toBeNull();
    // A duplicate delivery seconds later is skipped.
    forum.clock.advance(20_000);
    const second = await runSchedulerTick(tickDeps(forum, queue));
    expect(second.state).toBe("skipped_interval");
    expect(second.runId).toBeNull();
    expect(await db.select().from(schedulerRuns)).toHaveLength(1);
    // A jittered tick 55 s after the last run is not a duplicate.
    forum.clock.advance(35_000);
    expect((await runSchedulerTick(tickDeps(forum, queue))).state).not.toBe("skipped_interval");
  });

  it("skips when another worker holds the scheduler lock", async () => {
    const db = testDb();
    const forum = await buildForum(db);
    forum.clock.set(DAY);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const hasLock = new Promise<void>((resolve) => (locked = resolve));
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('agora:scheduler'))`);
      locked();
      await held;
    });
    await hasLock;
    const queue = new FakeQueue();
    const result = await runSchedulerTick(tickDeps(forum, queue));
    release();
    await holder;
    expect(result.state).toBe("skipped_interval");
    expect(await db.select().from(schedulerRuns)).toHaveLength(0);
    expect(await decisionsOf(db)).toHaveLength(0);
    expect(queue.sends).toHaveLength(0);
  });

  it("writes a paused run and sends nothing when the forum is paused", async () => {
    const db = testDb();
    const forum = await buildForum(db);
    const config = schedulerConfig((c) => {
      c.runtime.pauseAllActions = true;
    });
    const queue = new FakeQueue();
    const [result] = await runTicks(forum, queue, DAY, 1, config);
    expect(result?.state).toBe("paused");
    const [run] = await db.select().from(schedulerRuns);
    expect(run?.state).toBe("paused");
    expect(queue.sends).toHaveLength(0);
    expect(await decisionsOf(db)).toHaveLength(0);
  });

  it("writes a backpressure run when too many jobs are pending", async () => {
    const db = testDb();
    const forum = await buildForum(db);
    const config = schedulerConfig((c) => {
      c.runtime.maxPendingJobs = 100;
    });
    const queue = new FakeQueue();
    queue.pending = 100;
    const [result] = await runTicks(forum, queue, DAY, 1, config);
    expect(result?.state).toBe("backpressure");
    const [run] = await db.select().from(schedulerRuns);
    expect(run?.state).toBe("backpressure");
    expect(queue.sends).toHaveLength(0);
  });

  it("never chooses a suspended persona", async () => {
    const db = testDb();
    const forum = await buildForum(db);
    await db
      .update(personas)
      .set({ isSuspended: true })
      .where(eq(personas.id, forum.ids.slavica as string));
    await runTicks(forum, new FakeQueue(), DAY, 80);
    const rows = await decisionsOf(db);
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.some((r) => r.personaId === forum.ids.slavica)).toBe(false);
  });

  it("keeps a persona inside its own daily content cap", async () => {
    const db = testDb();
    const forum = await buildForum(db);
    await db
      .update(personas)
      .set({ limits: { ...LIMITS, maxContentActionsPerDay: 1 } })
      .where(eq(personas.id, forum.ids.domacin as string));
    await runTicks(forum, new FakeQueue(), DAY, 150);
    const rows = await decisionsOf(db);
    const content = rows.filter(
      (r) => r.personaId === forum.ids.domacin && r.kind !== "vote" && r.kind !== "summary",
    );
    expect(content.length).toBeLessThanOrEqual(1);
    // The others are not held back.
    expect(
      rows.filter((r) => r.personaId !== forum.ids.domacin && r.kind !== "vote").length,
    ).toBeGreaterThan(1);
  });

  it("keeps personas outside their active hours quiet", async () => {
    const db = testDb();
    const forum = await buildForum(db);
    await db
      .update(personas)
      .set({ limits: { ...LIMITS, activeHours: { from: 12, to: 20 } } })
      .where(eq(personas.id, forum.ids.novinar as string));
    await runTicks(forum, new FakeQueue(), DAY, 80);
    const rows = await decisionsOf(db);
    expect(rows.some((r) => r.personaId === forum.ids.novinar)).toBe(false);
    expect(rows.length).toBeGreaterThan(5);
  });

  it("respects the reply cooldown between a persona's content actions", async () => {
    const db = testDb();
    const forum = await buildForum(db);
    const limits = { ...LIMITS, replyCooldownMinutes: 30 };
    await db.update(personas).set({ limits });
    await runTicks(forum, new FakeQueue(), DAY, 180);
    const rows = (await decisionsOf(db))
      .filter((r) => r.kind === "thread" || r.kind === "reply")
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    expect(rows.length).toBeGreaterThan(3);
    const last = new Map<string, number>();
    for (const r of rows) {
      const prev = last.get(r.personaId as string);
      if (prev !== undefined)
        expect(r.createdAt.getTime() - prev).toBeGreaterThanOrEqual(30 * MINUTE);
      last.set(r.personaId as string, r.createdAt.getTime());
    }
  });

  it("does not let a persona extend a pair chain past the limit", async () => {
    const db = testDb();
    const forum = await buildForum(db);
    const t = forum.threadIds.kuhinja;
    // slavica -> skeptik -> slavica -> skeptik, the newest by skeptik.
    const a1 = await publishComment(
      forum,
      "slavica",
      "p1",
      t,
      "Mislim da je tamna ostava najbolja za ajvar u Srbiji.",
    );
    const b1 = await publishComment(
      forum,
      "skeptik",
      "p2",
      t,
      "A odakle ti taj podatak o ostavi u Srbiji?",
      a1,
    );
    const a2 = await publishComment(
      forum,
      "slavica",
      "p3",
      t,
      "Iz iskustva moje bake u Vojvodini, tamo se ajvar tako čuva.",
      b1,
    );
    const b2 = await publishComment(
      forum,
      "skeptik",
      "p4",
      t,
      "To je lepo, ali tražim neki izvor za Srbiju.",
      a2,
    );
    const config = schedulerConfig((c) => {
      c.personas.maxConsecutivePairReplies = 4;
      c.personas.minimumReplyCooldownMinutes = 1;
    });
    await db.update(personas).set({ limits: { ...LIMITS, replyCooldownMinutes: 1 } });
    await runTicks(forum, new FakeQueue(), DAY, 200, config);
    const rows = await decisionsOf(db);
    expect(rows.filter((r) => r.kind === "reply").length).toBeGreaterThan(3);
    expect(
      rows.some(
        (r) => r.kind === "reply" && r.targetId === b2 && r.personaId === forum.ids.slavica,
      ),
    ).toBe(false);

    // Control: the chain really is four long, so a limit of 4 blocks slavica and a limit of 5
    // would let her answer. (Whether she picks b2 among many targets is random, so the control
    // reads the chain itself instead of waiting for a pick.)
    const commentRows = await db
      .select({
        id: comments.id,
        authorPersonaId: comments.authorPersonaId,
        parentCommentId: comments.parentCommentId,
      })
      .from(comments);
    const byId = new Map(commentRows.map((row) => [row.id, row]));
    const chain = pairChainLength(byId.get(b2)!, forum.ids.slavica!, (id) => byId.get(id));
    expect(chain).toBe(4);
    expect(chain >= 4).toBe(true);
    expect(chain >= 5).toBe(false);
  }, 90_000);

  it("stays fast on a full-size snapshot (60 threads, 400 comments)", async () => {
    const db = testDb();
    const forum = await buildForum(db);
    await db.execute(sql`
      insert into threads (community_id, author_persona_id, title, body, script, search_text, last_activity_at, comment_count)
      select c.id, p.id, 'Tema ' || g, 'Telo teme ' || g, 'Latin', 'tema ' || g,
             ${DAY.toISOString()}::timestamptz - (g || ' minutes')::interval, 7
      from generate_series(1, 57) g
      cross join lateral (select id from communities order by slug offset (g % 3) limit 1) c
      cross join lateral (select id from personas order by slug offset (g % 5) limit 1) p`);
    await db.execute(sql`
      insert into comments (id, thread_id, root_comment_id, depth, author_persona_id, body, script, search_text, created_at, updated_at)
      select x.id, t.id, x.id, 0, p.id, 'Komentar ' || x.g, 'Latin', 'komentar ' || x.g,
             ${DAY.toISOString()}::timestamptz - (x.g || ' minutes')::interval, ${DAY.toISOString()}::timestamptz - (x.g || ' minutes')::interval
      from (select gen_random_uuid() as id, g from generate_series(1, 400) g) x
      cross join lateral (select id from threads order by id offset (x.g % 60) limit 1) t
      cross join lateral (select id from personas order by slug offset (x.g % 5) limit 1) p`);
    const queue = new FakeQueue();
    forum.clock.set(DAY);
    const times: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const started = performance.now();
      await runSchedulerTick(tickDeps(forum, queue));
      times.push(performance.now() - started);
      forum.clock.advance(MINUTE);
    }
    const average = times.reduce((a, b) => a + b, 0) / times.length;
    console.log(
      `full-size tick: average ${average.toFixed(0)} ms, max ${Math.max(...times).toFixed(0)} ms`,
    );
    expect(Math.max(...times)).toBeLessThan(500);
  });

  it("does not catch up after the worker was down", async () => {
    const db = testDb();
    const forum = await buildForum(db);
    const config = forum.ctx.config;
    await runTicks(forum, new FakeQueue(), DAY, 30);
    // Six hours with no ticks, then ticking resumes at 16:30.
    const resumeAt = new Date(DAY.getTime() + 6.5 * 60 * MINUTE);
    const resumed = await runTicks(forum, new FakeQueue(), resumeAt, 60);
    const hour = 16;
    const plannedIn = (kind: ActionKind) =>
      resumed.flatMap((r) => r.decisions).filter((d) => d.kind === kind).length;
    const bound = (daily: number) =>
      Math.ceil(2 * hourlyExpected(daily, hour, config.scheduler) + 1);
    expect(plannedIn("reply")).toBeLessThanOrEqual(bound(config.content.maxNewCommentsPerDay));
    expect(plannedIn("vote")).toBeLessThanOrEqual(bound(config.content.maxVotesPerDay));
    expect(plannedIn("thread")).toBeLessThanOrEqual(bound(config.content.maxNewThreadsPerDay));
    expect(resumed[0]?.decisions.length ?? 0).toBeLessThanOrEqual(
      config.scheduler.maxActionsPerTick,
    );
  });

  it("plans a due summary once, without a persona", async () => {
    const db = testDb();
    const forum = await buildForum(db);
    await db
      .update(threads)
      .set({ commentCount: 20 })
      .where(eq(threads.id, forum.threadIds.kuhinja));
    const queue = new FakeQueue();
    await runTicks(forum, queue, DAY, 6);
    const rows = (await decisionsOf(db)).filter((r) => r.kind === "summary");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.personaId).toBeNull();
    expect(rows[0]?.threadId).toBe(forum.threadIds.kuhinja);
    expect(rows[0]?.intent).toBe("summarize");
    expect(
      queue.sends.find((s) => s.kind === "summary")?.payload.contentVersion.threadCommentCount,
    ).toBe(20);
  });

  it("plans only votes when paid actions are paused", async () => {
    const db = testDb();
    const forum = await buildForum(db);
    const config = schedulerConfig((c) => {
      c.runtime.pausePaidActions = true;
    });
    await db
      .update(threads)
      .set({ commentCount: 20 })
      .where(eq(threads.id, forum.threadIds.kuhinja));
    const results = await runTicks(forum, new FakeQueue(), DAY, 60, config);
    const rows = await decisionsOf(db);
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.every((r) => r.kind === "vote")).toBe(true);
    expect(results.every((r) => r.stage === "paused")).toBe(true);
  });

  it("plans a revision for a challenged comment and passes the challenging reply along", async () => {
    const db = testDb();
    const forum = await buildForum(db);
    const t = forum.threadIds.kuhinja;
    const mine = await publishComment(
      forum,
      "slavica",
      "r1",
      t,
      "Ajvar u Srbiji traje samo mesec dana u tamnoj ostavi.",
    );
    const challenge = await publishComment(
      forum,
      "skeptik",
      "r2",
      t,
      "To nije tačno, u Srbiji se čuva i do godinu dana ako je dobro zatvoren.",
      mine,
      "correct_earlier",
    );
    const config = schedulerConfig((c) => {
      c.content.maxRevisionsPerDay = 50;
      c.scheduler.jobFreshnessMinutes = 240;
    });
    const queue = new FakeQueue();
    await runTicks(forum, queue, DAY, 200, config);
    const revisions = (await decisionsOf(db)).filter((r) => r.kind === "revision");
    expect(revisions.length).toBeGreaterThanOrEqual(1);
    expect(
      revisions.every((r) => r.targetId === mine && r.personaId === forum.ids.slavica),
    ).toBe(true);
    expect(revisions[0]?.intent).toBe("correct_earlier");
    // Never two queued revisions for one target.
    expect(revisions).toHaveLength(1);
    const sent = queue.sends.find((s) => s.kind === "revision");
    expect(sent?.payload.relatedCommentId).toBe(challenge);
    expect(sent?.payload.targetType).toBe("comment");
    expect(sent?.payload.contentVersion.targetRevision).toBe(1);
  });

  it("marks decisions skipped on a duplicate send and failed on an enqueue error", async () => {
    const db = testDb();
    const forum = await buildForum(db);
    const dup = new FakeQueue();
    dup.mode = "duplicate";
    await runTicks(forum, dup, DAY, 20);
    const dupRows = await decisionsOf(db);
    expect(dupRows.length).toBeGreaterThan(0);
    expect(dupRows.every((r) => r.outcome === "skipped" && r.outcomeCode === "duplicate")).toBe(
      true,
    );

    await resetScheduler(db);
    const bad = new FakeQueue();
    bad.mode = "throw";
    await runTicks(forum, bad, DAY, 20);
    const badRows = await decisionsOf(db);
    expect(badRows.length).toBeGreaterThan(0);
    expect(
      badRows.every((r) => r.outcome === "failed" && r.outcomeCode === "enqueue_error"),
    ).toBe(true);
  });

  it("does not exceed the per-tick cap and plans the same thing for the same inputs", async () => {
    const db = testDb();
    const forum = await buildForum(db);
    const config = schedulerConfig((c) => {
      c.scheduler.maxActionsPerTick = 2;
    });
    const results = await runTicks(forum, new FakeQueue(), DAY, 40, config);
    expect(results.every((r) => r.decisions.length <= 2)).toBe(true);
    const keys = results.map((r) =>
      r.decisions.map((d) => `${d.kind}:${d.personaId}:${d.targetId}`),
    );

    await resetScheduler(db);
    const again = await runTicks(forum, new FakeQueue(), DAY, 40, config);
    expect(
      again.map((r) => r.decisions.map((d) => `${d.kind}:${d.personaId}:${d.targetId}`)),
    ).toEqual(keys);
  });
});

describe("scheduler preview", () => {
  it("shows the best candidates with breakdowns and writes nothing", async () => {
    const db = testDb();
    const forum = await buildForum(db);
    const queue = new FakeQueue();
    forum.clock.set(DAY);
    const before = [
      (await db.select().from(schedulerRuns)).length,
      (await decisionsOf(db)).length,
    ];
    const preview = await previewSchedulerTick({ ...tickDeps(forum, queue), queue: null });
    expect(preview.stage).toBe("normal");
    expect(preview.slots.reply.expected).toBeGreaterThan(0);
    expect(preview.topCandidates.reply.length).toBeGreaterThan(0);
    expect(preview.topCandidates.reply.length).toBeLessThanOrEqual(5);
    const top = preview.topCandidates.reply[0]!;
    expect(top.decisionId).toBeNull();
    expect(top.personaName).toBeTruthy();
    expect(top.breakdown.features.length).toBeGreaterThan(0);
    const scores = preview.topCandidates.reply.map((c) => c.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect([
      (await db.select().from(schedulerRuns)).length,
      (await decisionsOf(db)).length,
    ]).toEqual(before);
    expect(queue.sends).toHaveLength(0);
  });

  it("applies the budget stage: only votes survive when paid actions are paused", async () => {
    const db = testDb();
    const forum = await buildForum(db);
    const config = schedulerConfig((c) => {
      c.runtime.pausePaidActions = true;
    });
    forum.clock.set(DAY);
    const preview = await previewSchedulerTick({
      ...tickDeps(forum, new FakeQueue(), config),
      queue: null,
    });
    expect(preview.stage).toBe("paused");
    expect(preview.topCandidates.reply).toHaveLength(0);
    expect(preview.topCandidates.thread).toHaveLength(0);
    expect(preview.topCandidates.vote.length).toBeGreaterThan(0);
  });
});
