import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  buildReport,
  defaultScenario,
  runSimulation,
  type RunRecord,
  type SimulationReport,
} from "@/lib/simulation";
import { testDb } from "./helpers";

async function simulate(
  options: Parameters<typeof defaultScenario>[0],
): Promise<{ record: RunRecord; report: SimulationReport }> {
  const db = testDb();
  const scenario = defaultScenario(options);
  const record = await runSimulation(db, scenario);
  const report = await buildReport(db, scenario, record);
  return { record, report };
}

/**
 * What two runs with the same seed must agree on: the ticks and the number of
 * threads and replies each day, with their outcomes. Votes, revisions and
 * summaries are left out on purpose. Services give threads and comments random
 * uuids and the database does the same for personas, and the scheduler seeds
 * some of its choices (vote pairs, tie-breaks, who revises) from those ids, so
 * these counts can differ by one or two between runs while everything the clock
 * and the seed decide stays identical.
 */
function fingerprint(report: SimulationReport): unknown {
  return {
    ticks: report.ticks,
    perDay: report.perDay.filter((row) => row.kind === "thread" || row.kind === "reply"),
    skipped: report.skippedByCode,
  };
}

describe("48-hour simulation", () => {
  it(
    "keeps every Phase 2 promise over two simulated days",
    async () => {
      const { record, report } = await simulate({ tickMinutes: 2 });
      const db = testDb();

      expect(report.violations).toEqual([]);
      // Every check had enough data to be judged.
      expect(report.checks.filter((c) => c.status === "not_evaluated")).toEqual([]);
      expect(report.checks).toHaveLength(16);

      // The forum did real work.
      expect(report.outcomes.published ?? 0).toBeGreaterThan(100);
      expect(report.diversity.newThreads).toBeGreaterThan(10);

      // The outage falls in daytime (Monday 08:00 to 14:00 in Belgrade): the worker dies
      // with a job queued, no tick runs for about six hours, and that job meets the
      // restart as stale instead of being replayed. "No catch-up" is judged against
      // a real daytime pace.
      expect(report.scenario.workerOutage).toEqual({ fromHour: 3, toHour: 9 });
      expect(report.checks.find((c) => c.id === 7)?.status).toBe("pass");
      expect(report.ticks.skippedForOutage).toBeGreaterThan(150);
      expect(report.events.some((e) => e.text.startsWith("Worker outage begins"))).toBe(true);
      expect(report.skippedByCode.stale ?? 0).toBeGreaterThanOrEqual(1);

      // All three degraded budget stages appeared on day two, in order.
      const moves = report.stageTransitions.map((t) => `${t.from}>${t.to}`);
      const reduced = moves.indexOf("normal>reduced");
      const minimal = moves.indexOf("reduced>minimal");
      const paused = moves.indexOf("minimal>paused");
      expect(reduced).toBeGreaterThanOrEqual(0);
      expect(minimal).toBeGreaterThan(reduced);
      expect(paused).toBeGreaterThan(minimal);
      // The next UTC day starts afresh.
      expect(moves.at(-1)).toBe("paused>normal");
      const day2 = report.budgetDays.find((d) => d.day === "2026-11-03");
      expect(day2?.limitUsd).toBe(0.06);
      expect((day2?.spentUsd ?? 1) + (day2?.reservedUsd ?? 1)).toBeLessThanOrEqual(0.06);

      // The pause: nothing created, and the check says so.
      const pauseCheck = report.checks.find((c) => c.id === 8);
      expect(pauseCheck?.status).toBe("pass");
      // A job that was queued when the pause began ended as skipped instead of running.
      expect(report.skippedByCode.paused ?? 0).toBeGreaterThanOrEqual(1);
      expect(record.pauseWindow?.to).not.toBeNull();

      // The scripted failure used every attempt and ended as a dead letter.
      expect(record.scriptedFailureKeys).toHaveLength(1);
      expect(record.queue.deadLetters).toBeGreaterThanOrEqual(1);
      expect(report.outcomes.failed ?? 0).toBeGreaterThanOrEqual(1);
      expect(report.outcomes.queued ?? 0).toBe(0);

      // Bad drafts: some first drafts were repaired (once each), some stayed bad and
      // were quarantined, and a quarantined decision never published anything.
      expect(report.faults.badDrafts).toBeGreaterThan(0);
      expect(report.repairs.calls).toBeGreaterThan(0);
      expect(report.repairs.quarantined).toBeGreaterThan(0);
      expect(report.checks.find((c) => c.id === 15)?.status).toBe("pass");
      expect(report.checks.find((c) => c.id === 16)?.status).toBe("pass");

      // The duplicate delivery changed nothing.
      expect(record.duplicate).not.toBeNull();
      expect(record.duplicate?.outcome).toBe("skipped");
      expect(record.duplicate?.contentAfter).toBe(record.duplicate?.contentBefore);
      expect(record.duplicate?.decisionOutcomeAfter).toBe(
        record.duplicate?.decisionOutcomeBefore,
      );

      // Retention: fixtures are gone, valid ones stay, memories are bounded.
      const counts = await db.execute<{
        sessions: number;
        attempts: number;
        memories: number;
      }>(sql`
        select
          (select count(*) from sessions)::int as sessions,
          (select count(*) from login_attempts where key like 'ip:sim-fixture-%')::int as attempts,
          (select count(*) from persona_memories where expires_at < '2026-11-02T04:00:00Z')::int as memories`);
      expect(counts.rows[0]).toEqual({ sessions: 2, attempts: 0, memories: 0 });
      expect(Math.max(...record.cleanup.maxMemoriesAfterCleanup)).toBeLessThanOrEqual(60);
      expect(record.cleanup.runs["cleanup-sessions"]).toBe(2);
      expect(record.cleanup.runs["cleanup-persona-memory"]).toBe(2);
      expect(record.cleanup.totals["cleanup-sessions"]?.sessions).toBe(5);
      expect(record.cleanup.totals["cleanup-login-attempts"]?.loginAttempts).toBe(20);

      // Money: the metered mock cost something, and every call is on the books.
      expect(report.budgetDays[0]?.spentUsd).toBeGreaterThan(0);
      expect(report.providerCalls.length).toBeGreaterThan(0);
    },
    10 * 60_000,
  );

  it(
    "repeats exactly when run twice with the same seed",
    async () => {
      const first = await simulate({ hours: 3, tickMinutes: 2 });
      const second = await simulate({ hours: 3, tickMinutes: 2 });
      expect(first.report.outcomes.published ?? 0).toBeGreaterThan(0);
      expect(fingerprint(second.report)).toEqual(fingerprint(first.report));
    },
    3 * 60_000,
  );
});
