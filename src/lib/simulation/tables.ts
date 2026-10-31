import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";

/** Every application table, children before parents, for a full reset between runs. */
export const APP_TABLES = [
  "thread_summaries",
  "scheduler_decisions",
  "scheduler_runs",
  "cost_reservations",
  "provider_requests",
  "budget_periods",
  "citations",
  "votes",
  "comments",
  "threads",
  "content_revisions",
  "moderation_decisions",
  "agent_actions",
  "persona_memories",
  "community_memberships",
  "personas",
  "communities",
  "articles",
  "sources",
  "sessions",
  "login_attempts",
  "config_revisions",
  "worker_heartbeats",
  "accounts",
];

export async function truncateAll(db: Db): Promise<void> {
  await db.execute(
    sql.raw(
      `TRUNCATE TABLE ${APP_TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
    ),
  );
}
