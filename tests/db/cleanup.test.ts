import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createSession } from "@/lib/auth/session";
import { ManualClock } from "@/lib/clock";
import { STANDARD_PRESET } from "@/lib/config/presets";
import { CostGateway, SIMULATION_PRICE_TABLE } from "@/lib/costs";
import {
  costReservations,
  loginAttempts,
  personaMemories,
  schedulerDecisions,
  schedulerRuns,
  sessions,
} from "@/lib/db/schema";
import { buildServiceContext } from "@/lib/domain/context";
import { CLEANUP_SCHEDULE, runCleanup } from "@/lib/jobs/cleanup";
import { MAX_MEMORIES_PER_PERSONA } from "@/lib/domain/personas";
import { createProviders } from "@/lib/providers";
import { seedMinimal, testDb } from "./helpers";

const db = testDb();
const DAY = 86_400_000;
const NOW = new Date("2026-10-10T10:00:00Z");

function deps() {
  const clock = new ManualClock(NOW);
  return { db, clock, config: structuredClone(STANDARD_PRESET) };
}

async function people() {
  const ctx = buildServiceContext({
    db,
    config: STANDARD_PRESET,
    providers: createProviders("mock"),
  });
  return seedMinimal(ctx);
}

describe("cleanup schedule", () => {
  it("uses the queue names the admin pages read", () => {
    expect(CLEANUP_SCHEDULE.map((s) => s.name)).toEqual([
      "cleanup-sessions",
      "cleanup-login-attempts",
      "cleanup-persona-memory",
      "cleanup-scheduler-history",
      "reconcile-reservations",
    ]);
  });
});

describe("cleanup jobs", () => {
  it("removes only expired sessions", async () => {
    const p = await people();
    const d = deps();
    const old = await createSession(
      db,
      p.personaA.accountId,
      {},
      new Date(NOW.getTime() - 30 * DAY),
    );
    const fresh = await createSession(db, p.personaB.accountId, {}, NOW);
    expect(old.expiresAt.getTime()).toBeLessThan(NOW.getTime());
    const counts = await runCleanup("cleanup-sessions", d);
    expect(counts).toEqual({ sessions: 1 });
    const left = await db.select({ expiresAt: sessions.expiresAt }).from(sessions);
    expect(left).toHaveLength(1);
    expect(left[0]?.expiresAt).toEqual(fresh.expiresAt);
  });

  it("removes old login attempts but keeps recent and still-locked ones", async () => {
    const d = deps();
    const longAgo = new Date(NOW.getTime() - 3 * DAY);
    await db.insert(loginAttempts).values([
      { key: "ip:old", failures: 2, windowStartedAt: longAgo, updatedAt: longAgo },
      {
        key: "ip:locked",
        failures: 9,
        windowStartedAt: longAgo,
        updatedAt: longAgo,
        lockedUntil: new Date(NOW.getTime() + 60_000),
      },
      { key: "ip:recent", failures: 1, windowStartedAt: NOW, updatedAt: NOW },
    ]);
    expect(await runCleanup("cleanup-login-attempts", d)).toEqual({ loginAttempts: 1 });
    const keys = (await db.select({ key: loginAttempts.key }).from(loginAttempts))
      .map((r) => r.key)
      .sort();
    expect(keys).toEqual(["ip:locked", "ip:recent"]);
  });

  it("removes expired memories and trims each persona to the bound", async () => {
    const p = await people();
    const d = deps();
    await db.insert(personaMemories).values([
      {
        personaId: p.personaAId,
        kind: "view",
        content: "istekla",
        createdAt: new Date(NOW.getTime() - 40 * DAY),
        expiresAt: new Date(NOW.getTime() - DAY),
      },
      ...Array.from({ length: MAX_MEMORIES_PER_PERSONA + 5 }, (_, i) => ({
        personaId: p.personaBId,
        kind: "view" as const,
        content: `beleška ${i}`,
        createdAt: new Date(NOW.getTime() - i * 60_000),
        expiresAt: new Date(NOW.getTime() + 10 * DAY),
      })),
    ]);
    expect(await runCleanup("cleanup-persona-memory", d)).toEqual({ expired: 1, trimmed: 5 });
    const rows = await db.select().from(personaMemories);
    expect(rows.filter((r) => r.personaId === p.personaBId)).toHaveLength(
      MAX_MEMORIES_PER_PERSONA,
    );
    expect(rows.some((r) => r.content === "istekla")).toBe(false);
  });

  it("prunes scheduler history by audit retention and quiet-run age, keeping planned rows", async () => {
    const d = deps();
    const retention = d.config.storage.detailedOperationalAuditRetentionDays;
    const at = (days: number) => new Date(NOW.getTime() - days * DAY);
    const run = async (state: "planned" | "idle" | "paused", days: number) => {
      const [row] = await db
        .insert(schedulerRuns)
        .values({ tickAt: at(days), createdAt: at(days), state, budgetStage: "normal" })
        .returning({ id: schedulerRuns.id });
      return row?.id ?? "";
    };
    const ancientPlanned = await run("planned", retention + 1);
    await run("idle", 8);
    await run("paused", 9);
    const oldPlanned = await run("planned", 8);
    const recentIdle = await run("idle", 1);
    await db.insert(schedulerDecisions).values(
      [ancientPlanned, oldPlanned].map((runId, i) => ({
        runId,
        kind: "vote" as const,
        actionKey: `cleanup:${i}`,
        score: 1,
        breakdown: { features: [], base: 1, stageFactor: 1, total: 1 },
        notAfter: NOW,
        createdAt: at(8),
      })),
    );

    const counts = await runCleanup("cleanup-scheduler-history", d);
    expect(counts).toEqual({ expiredDecisions: 0, runsPastAudit: 1, quietRuns: 2 });
    const left = (await db.select({ id: schedulerRuns.id }).from(schedulerRuns)).map(
      (r) => r.id,
    );
    expect(left.sort()).toEqual([oldPlanned, recentIdle].sort());
    // Decisions cascade with their run.
    const decisions = await db
      .select({ key: schedulerDecisions.actionKey })
      .from(schedulerDecisions);
    expect(decisions).toEqual([{ key: "cleanup:1" }]);
  });

  it("marks decisions whose job vanished as expired, leaving live and finished ones alone", async () => {
    const d = deps();
    const [run] = await db
      .insert(schedulerRuns)
      .values({ tickAt: NOW, createdAt: NOW, state: "planned", budgetStage: "normal" })
      .returning({ id: schedulerRuns.id });
    const decision = (
      key: string,
      notAfterMinutesAgo: number,
      outcome: "queued" | "published",
    ) => ({
      runId: run?.id ?? "",
      kind: "vote" as const,
      actionKey: key,
      score: 1,
      breakdown: { features: [], base: 1, stageFactor: 1, total: 1 },
      notAfter: new Date(NOW.getTime() - notAfterMinutesAgo * 60_000),
      outcome,
    });
    await db
      .insert(schedulerDecisions)
      .values([
        decision("lost", 120, "queued"),
        decision("live", 30, "queued"),
        decision("done", 120, "published"),
      ]);

    const counts = await runCleanup("cleanup-scheduler-history", d);
    expect(counts.expiredDecisions).toBe(1);
    const rows = await db
      .select({
        key: schedulerDecisions.actionKey,
        outcome: schedulerDecisions.outcome,
        code: schedulerDecisions.outcomeCode,
      })
      .from(schedulerDecisions);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey.lost).toMatchObject({ outcome: "skipped", code: "expired" });
    expect(byKey.live).toMatchObject({ outcome: "queued", code: null });
    expect(byKey.done).toMatchObject({ outcome: "published" });
  });

  it("settles stale reservations", async () => {
    const d = deps();
    const gateway = new CostGateway({
      db,
      config: d.config,
      clock: d.clock,
      prices: SIMULATION_PRICE_TABLE,
    });
    await expect(
      gateway.run(
        {
          actionKey: "cleanup:res",
          purpose: "generation",
          origin: "simulation",
          provider: "mock",
          model: "mock-deterministic-v1",
          estimatePayload: { x: 1 },
          maxOutputTokens: 200,
        },
        () => Promise.reject(new Error("socket hang up")),
      ),
    ).rejects.toThrow();
    const [before] = await db.select().from(costReservations);
    expect(before?.status).toBe("ambiguous");

    d.clock.advance(61 * 60_000);
    expect(await runCleanup("reconcile-reservations", d)).toEqual({
      markedAmbiguous: 0,
      settled: 1,
    });
    const [after] = await db
      .select()
      .from(costReservations)
      .where(eq(costReservations.id, before?.id ?? ""));
    expect(after?.status).toBe("settled");
  });
});
