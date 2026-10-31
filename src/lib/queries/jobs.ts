import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import { agentActions, personas, schedulerDecisions } from "@/lib/db/schema";
import { ACTION_QUEUES, DEAD_LETTER_QUEUE } from "@/lib/jobs/types";

export const CLEANUP_QUEUES = [
  "cleanup-sessions",
  "cleanup-login-attempts",
  "cleanup-persona-memory",
  "cleanup-scheduler-history",
  "reconcile-reservations",
] as const;

export const QUEUE_GROUPS: { title: string; names: string[] }[] = [
  { title: "Akcije", names: Object.values(ACTION_QUEUES) },
  { title: "Mrtvo pismo", names: [DEAD_LETTER_QUEUE] },
  { title: "Održavanje", names: [...CLEANUP_QUEUES] },
];

export interface QueueStats {
  name: string;
  created: number;
  retry: number;
  active: number;
  completed24h: number;
  failed24h: number;
  lastCompletedAt: Date | null;
}

/** null when pg-boss has never created its schema (the worker has not run yet). */
export async function getQueueStats(db: DbOrTx, now: Date): Promise<QueueStats[] | null> {
  const probe = await db.execute<{ present: string | null }>(
    sql`select to_regclass('pgboss.job')::text as present`,
  );
  if (!probe.rows[0]?.present) return null;
  const names = QUEUE_GROUPS.flatMap((g) => g.names);
  const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const rows = await db.execute<{
    name: string;
    created: string;
    retry: string;
    active: string;
    completed24h: string;
    failed24h: string;
    lastCompletedAt: Date | string | null;
  }>(sql`
    select name,
      count(*) filter (where state = 'created') as created,
      count(*) filter (where state = 'retry') as retry,
      count(*) filter (where state = 'active') as active,
      count(*) filter (where state = 'completed' and completed_on >= ${since}::timestamptz) as "completed24h",
      count(*) filter (where state = 'failed' and completed_on >= ${since}::timestamptz) as "failed24h",
      max(completed_on) filter (where state = 'completed') as "lastCompletedAt"
    from pgboss.job
    where name in (${sql.join(
      names.map((n) => sql`${n}`),
      sql`, `,
    )})
    group by name
  `);
  const byName = new Map(rows.rows.map((r) => [r.name, r]));
  return names.map((name) => {
    const r = byName.get(name);
    return {
      name,
      created: Number(r?.created ?? 0),
      retry: Number(r?.retry ?? 0),
      active: Number(r?.active ?? 0),
      completed24h: Number(r?.completed24h ?? 0),
      failed24h: Number(r?.failed24h ?? 0),
      lastCompletedAt: r?.lastCompletedAt ? new Date(r.lastCompletedAt) : null,
    };
  });
}

export async function listDeadLetterDecisions(db: DbOrTx, limit = 30) {
  return db
    .select({
      id: schedulerDecisions.id,
      createdAt: schedulerDecisions.createdAt,
      kind: schedulerDecisions.kind,
      personaName: personas.displayName,
      actionKey: schedulerDecisions.actionKey,
      error: agentActions.error,
    })
    .from(schedulerDecisions)
    .leftJoin(personas, eq(personas.id, schedulerDecisions.personaId))
    .leftJoin(agentActions, eq(agentActions.id, schedulerDecisions.actionId))
    .where(
      and(
        eq(schedulerDecisions.outcome, "failed"),
        eq(schedulerDecisions.outcomeCode, "dead_letter"),
      ),
    )
    .orderBy(desc(schedulerDecisions.createdAt))
    .limit(limit);
}

export async function countSkippedByCode(db: DbOrTx, now: Date) {
  const since = new Date(now.getTime() - 24 * 3_600_000);
  return db
    .select({ code: schedulerDecisions.outcomeCode, n: count() })
    .from(schedulerDecisions)
    .where(
      and(eq(schedulerDecisions.outcome, "skipped"), gte(schedulerDecisions.createdAt, since)),
    )
    .groupBy(schedulerDecisions.outcomeCode)
    .orderBy(desc(count()));
}

export const SKIP_CODE_EXPLANATIONS: Record<string, string> = {
  stale: "Posao je kasnio i kad je došao na red, predviđeno vreme je već prošlo.",
  paused: "Akcije su bile pauzirane kad je posao stigao na red.",
  content_changed: "Tema ili komentar su se u međuvremenu promenili, pa plan više ne važi.",
  cooldown: "Sagovornik je nedavno bio aktivan, pa mora da sačeka.",
  duplicate: "Isti posao je već bio u redu.",
  budget_paused: "Budžet je u fazi pauze, pa plaćeni rad nije pokrenut.",
  budget_exhausted: "Budžet je potrošen, pa plaćeni rad nije pokrenut.",
};

export function explainSkipCode(code: string | null): string {
  if (!code) return "Bez zabeleženog razloga.";
  const known = SKIP_CODE_EXPLANATIONS[code];
  if (known) return known;
  if (code.startsWith("budget_")) return "Budžet nije dozvolio plaćeni rad u tom trenutku.";
  return "Razlog nije posebno opisan.";
}
