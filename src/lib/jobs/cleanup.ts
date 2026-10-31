import { and, eq, inArray, lt } from "drizzle-orm";
import { deleteExpiredSessions } from "@/lib/auth/session";
import { pruneLoginAttempts } from "@/lib/auth/throttle";
import type { Clock } from "@/lib/clock";
import type { AgoraConfig } from "@/lib/config/schema";
import { reconcileReservations } from "@/lib/costs/gateway";
import type { Db } from "@/lib/db/client";
import { schedulerDecisions, schedulerRuns } from "@/lib/db/schema";
import { pruneExpiredMemories } from "@/lib/domain/personas";

export type CleanupKind =
  | "cleanup-sessions"
  | "cleanup-login-attempts"
  | "cleanup-persona-memory"
  | "cleanup-scheduler-history"
  | "reconcile-reservations";

/** Cron expressions are evaluated in Europe/Belgrade by the worker. */
export const CLEANUP_SCHEDULE: readonly { name: CleanupKind; cron: string }[] = [
  { name: "cleanup-sessions", cron: "10 3 * * *" },
  { name: "cleanup-login-attempts", cron: "5 * * * *" },
  { name: "cleanup-persona-memory", cron: "20 3 * * *" },
  { name: "cleanup-scheduler-history", cron: "30 3 * * *" },
  { name: "reconcile-reservations", cron: "*/10 * * * *" },
];

/** Ticks that did nothing are only useful for a short while. */
const QUIET_RUN_RETENTION_DAYS = 7;
const QUIET_STATES = ["idle", "paused", "backpressure", "skipped_interval"] as const;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export interface CleanupDeps {
  db: Db;
  config: AgoraConfig;
  clock: Clock;
}

/** Runs one cleanup and returns its counts. */
export async function runCleanup(
  kind: CleanupKind,
  { db, config, clock }: CleanupDeps,
): Promise<Record<string, number>> {
  const now = clock.now();
  switch (kind) {
    case "cleanup-sessions":
      return { sessions: await deleteExpiredSessions(db, now) };
    case "cleanup-login-attempts":
      return { loginAttempts: await pruneLoginAttempts(db, now) };
    case "cleanup-persona-memory":
      return { ...(await pruneExpiredMemories(db, now)) };
    case "cleanup-scheduler-history": {
      // Decisions go with their run (cascade); runs that planned something are
      // kept for the full audit retention, quiet ones only for a week.
      const audit = new Date(
        now.getTime() - config.storage.detailedOperationalAuditRetentionDays * DAY_MS,
      );
      const quiet = new Date(now.getTime() - QUIET_RUN_RETENTION_DAYS * DAY_MS);
      // A decision whose job vanished (pg-boss drops jobs left unclaimed past
      // its retention, which only a multi-day outage causes) would otherwise
      // stay "queued" forever.
      const expired = await db
        .update(schedulerDecisions)
        .set({ outcome: "skipped", outcomeCode: "expired", completedAt: now })
        .where(
          and(
            eq(schedulerDecisions.outcome, "queued"),
            lt(schedulerDecisions.notAfter, new Date(now.getTime() - HOUR_MS)),
          ),
        )
        .returning({ id: schedulerDecisions.id });
      const old = await db
        .delete(schedulerRuns)
        .where(lt(schedulerRuns.createdAt, audit))
        .returning({ id: schedulerRuns.id });
      const idle = await db
        .delete(schedulerRuns)
        .where(
          and(
            lt(schedulerRuns.createdAt, quiet),
            inArray(schedulerRuns.state, [...QUIET_STATES]),
          ),
        )
        .returning({ id: schedulerRuns.id });
      return {
        expiredDecisions: expired.length,
        runsPastAudit: old.length,
        quietRuns: idle.length,
      };
    }
    case "reconcile-reservations":
      return { ...(await reconcileReservations(db, clock)) };
  }
}
