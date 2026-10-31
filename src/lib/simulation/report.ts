import { asc, eq, gte, sql } from "drizzle-orm";
import type { BudgetStage } from "@/lib/costs";
import type { Db } from "@/lib/db/client";
import {
  budgetPeriods,
  communities,
  comments,
  personas,
  schedulerDecisions,
  schedulerRuns,
  threads,
} from "@/lib/db/schema";
import { dailyMaxFor } from "@/lib/scheduler/pacing";
import { belgradeDayKey, belgradeParts } from "@/lib/time";
import {
  evaluateChecks,
  groupCount,
  isExecuted,
  topShare,
  violationsOf,
  type CheckResult,
  type ContentFact,
  type DecisionFact,
  type EvalInput,
  type PeriodFact,
  type RetentionState,
  type RunFact,
} from "./checks";
import type { RunRecord } from "./run";
import type { Scenario } from "./scenario";

const HOUR = 3_600_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface SimulationReport {
  scenario: {
    name: string;
    start: string;
    end: string;
    hours: number;
    tickMinutes: number;
    seed: string;
    dailyLimitUsd: number;
    loweredLimit: { fromHour: number; limitUsd: number } | null;
    /** The hour the owner lowers the daily limit to the amount spent so far (shows the paused stage). */
    limitCutHour: number | null;
    workerOutage: { fromHour: number; toHour: number } | null;
    forumPause: { fromHour: number; toHour: number } | null;
  };
  wallClockSeconds: number;
  ticks: { run: number; skippedForOutage: number };
  perDay: {
    day: string;
    kind: string;
    published: number;
    quarantined: number;
    max: number;
  }[];
  hourly: {
    index: number;
    belgrade: string;
    planned: number;
    published: number;
    quarantined: number;
    skipped: number;
    failed: number;
    stage: BudgetStage | null;
    note: string;
  }[];
  stageTransitions: { at: string; from: BudgetStage; to: BudgetStage }[];
  budgetDays: {
    day: string;
    limitUsd: number;
    spentUsd: number;
    reservedUsd: number;
    ambiguousCalls: number;
    ambiguousUsd: number;
  }[];
  providerCalls: { purpose: string; status: string; count: number }[];
  jobs: RunRecord["queue"];
  outcomes: Record<string, number>;
  skippedByCode: Record<string, number>;
  faults: RunRecord["faults"];
  scriptedFailureKeys: string[];
  /** Paid repairs, the actions they covered, and decisions that ended quarantined. */
  repairs: { calls: number; actions: number; quarantined: number };
  diversity: {
    communitiesWithNewThreads: number;
    communityCount: number;
    topCommunityShare: number;
    topCommunity: string | null;
    personasThatCommented: number;
    personaCount: number;
    topPersonaShare: number;
    topPersona: string | null;
    newThreads: number;
    newComments: number;
  };
  cleanup: RunRecord["cleanup"];
  events: { at: string; text: string }[];
  checks: CheckResult[];
  /** Empty means every promise held. */
  violations: string[];
}

const iso = (d: Date): string => d.toISOString();
const usd = (micros: number): number => Math.round(micros) / 1e6;

function belgradeLabel(date: Date): string {
  const p = belgradeParts(date);
  return `${WEEKDAYS[p.weekday]} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

async function loadFacts(
  db: Db,
  scenario: Scenario,
  record: RunRecord,
): Promise<{
  input: EvalInput;
  decisions: DecisionFact[];
  runs: RunFact[];
  periods: PeriodFact[];
  personaNames: Map<string, string>;
  communityNames: Map<string, string>;
}> {
  const decisionRows = await db
    .select({
      id: schedulerDecisions.id,
      kind: schedulerDecisions.kind,
      personaId: schedulerDecisions.personaId,
      threadId: schedulerDecisions.threadId,
      outcome: schedulerDecisions.outcome,
      code: schedulerDecisions.outcomeCode,
      createdAt: schedulerDecisions.createdAt,
      completedAt: schedulerDecisions.completedAt,
    })
    .from(schedulerDecisions)
    .orderBy(asc(schedulerDecisions.createdAt));
  const decisions: DecisionFact[] = decisionRows;

  const personaRows = await db
    .select({ id: personas.id, name: personas.displayName, limits: personas.limits })
    .from(personas);
  const personaFacts = personaRows.map((p) => ({
    id: p.id,
    name: p.name,
    maxContentActionsPerDay: p.limits.maxContentActionsPerDay,
    replyCooldownMinutes: p.limits.replyCooldownMinutes,
  }));

  const communityRows = await db
    .select({ id: communities.id, name: communities.name, active: communities.isActive })
    .from(communities);

  const threadRows = await db
    .select({
      id: threads.id,
      communityId: threads.communityId,
      authorId: threads.authorPersonaId,
      createdAt: threads.createdAt,
    })
    .from(threads)
    .where(eq(threads.status, "published"));
  const commentRows = await db
    .select({
      id: comments.id,
      threadId: comments.threadId,
      parentId: comments.parentCommentId,
      authorId: comments.authorPersonaId,
      createdAt: comments.createdAt,
    })
    .from(comments)
    .where(eq(comments.status, "published"));
  const content: ContentFact[] = [
    ...threadRows.map((t) => ({
      id: t.id,
      isThread: true,
      threadId: t.id,
      parentId: null,
      authorId: t.authorId,
      communityId: t.communityId,
      createdAt: t.createdAt,
    })),
    ...commentRows.map((c) => ({
      id: c.id,
      isThread: false,
      threadId: c.threadId,
      parentId: c.parentId,
      authorId: c.authorId,
      communityId: null,
      createdAt: c.createdAt,
    })),
  ];

  const runRows = await db
    .select({
      tickAt: schedulerRuns.tickAt,
      state: schedulerRuns.state,
      stage: schedulerRuns.budgetStage,
    })
    .from(schedulerRuns)
    .where(gte(schedulerRuns.tickAt, scenario.start))
    .orderBy(asc(schedulerRuns.tickAt));
  const runs: RunFact[] = runRows;

  const periodRows = await db
    .select()
    .from(budgetPeriods)
    .orderBy(asc(budgetPeriods.periodStart));
  const periods: PeriodFact[] = periodRows.map((p) => ({
    kind: p.kind,
    start: p.periodStart,
    limitMicros: p.limitMicros,
    spentMicros: p.spentMicros,
    reservedMicros: p.reservedMicros,
  }));

  const pause =
    record.pauseWindow && record.pauseWindow.to
      ? { from: record.pauseWindow.from, to: record.pauseWindow.to }
      : null;
  let rowsCreatedInPause = 0;
  if (pause) {
    const rows = await db.execute<{ n: number }>(sql`
      select (
        (select count(*) from threads where created_at >= ${pause.from} and created_at < ${pause.to}) +
        (select count(*) from comments where created_at >= ${pause.from} and created_at < ${pause.to}) +
        (select count(*) from votes where created_at >= ${pause.from} and created_at < ${pause.to}) +
        (select count(*) from thread_summaries where created_at >= ${pause.from} and created_at < ${pause.to}) +
        (select count(*) from content_revisions where created_at >= ${pause.from} and created_at < ${pause.to})
      )::int as n`);
    rowsCreatedInPause = Number(rows.rows[0]?.n ?? 0);
  }

  const dupRows = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from (select action_key from agent_actions group by 1 having count(*) > 1) x`,
  );

  const repairRows = await db.execute<{ calls: number; keys: number; over: number }>(sql`
    select coalesce(sum(n), 0)::int as calls, count(*)::int as keys,
           count(*) filter (where n > 1)::int as over
    from (select count(*) as n from provider_requests
          where purpose = 'repair' and action_key is not null group by action_key) x`);
  const quarantineRows = await db.execute<{ total: number; leaked: number }>(sql`
    select count(*)::int as total,
           count(*) filter (where a.status <> 'quarantined' or a.result_id is not null
             or exists (select 1 from threads t where t.id = a.result_id)
             or exists (select 1 from comments c where c.id = a.result_id))::int as leaked
    from scheduler_decisions d
    left join agent_actions a on a.id = d.action_id
    where d.outcome = 'quarantined' and d.created_at >= ${scenario.start}`);

  const ids = record.retention;
  const countWhere = async (query: ReturnType<typeof sql>): Promise<number> => {
    const rows = await db.execute<{ n: number }>(query);
    return Number(rows.rows[0]?.n ?? 0);
  };
  const retention: RetentionState = {
    expiredSessionsLeft: ids.expiredSessionIds.length
      ? await countWhere(
          sql`select count(*)::int as n from sessions where id in (${sql.join(
            ids.expiredSessionIds.map((i) => sql`${i}::uuid`),
            sql`, `,
          )})`,
        )
      : 0,
    validSessionsLeft: ids.validSessionIds.length
      ? await countWhere(
          sql`select count(*)::int as n from sessions where id in (${sql.join(
            ids.validSessionIds.map((i) => sql`${i}::uuid`),
            sql`, `,
          )})`,
        )
      : 0,
    oldLoginAttemptsLeft: ids.oldLoginKeys.length
      ? await countWhere(
          sql`select count(*)::int as n from login_attempts where key in (${sql.join(
            ids.oldLoginKeys.map((i) => sql`${i}`),
            sql`, `,
          )})`,
        )
      : 0,
    expiredMemoriesLeft: ids.expiredMemoryIds.length
      ? await countWhere(
          sql`select count(*)::int as n from persona_memories where id in (${sql.join(
            ids.expiredMemoryIds.map((i) => sql`${i}::uuid`),
            sql`, `,
          )})`,
        )
      : 0,
  };

  const newThreads = threadRows.filter((t) => t.createdAt >= scenario.start).length;
  const newComments = commentRows.filter((c) => c.createdAt >= scenario.start).length;

  const input: EvalInput = {
    scenario,
    end: record.end,
    personas: personaFacts,
    communityCount: communityRows.filter((c) => c.active).length,
    decisions,
    content,
    runs,
    periods,
    rowsCreatedInPause,
    pauseWindow: pause,
    outageWindow: record.outageWindow,
    queue: record.queue,
    scriptedFailures: record.scriptedFailureKeys.length,
    duplicate: record.duplicate,
    cleanup: record.cleanup,
    retention,
    duplicateActionKeys: Number(dupRows.rows[0]?.n ?? 0),
    publishedThreadsNew: newThreads,
    publishedCommentsNew: newComments,
    repairCalls: Number(repairRows.rows[0]?.calls ?? 0),
    repairKeys: Number(repairRows.rows[0]?.keys ?? 0),
    repairKeysOverLimit: Number(repairRows.rows[0]?.over ?? 0),
    quarantinedDecisions: Number(quarantineRows.rows[0]?.total ?? 0),
    quarantinedWithContent: Number(quarantineRows.rows[0]?.leaked ?? 0),
  };
  return {
    input,
    decisions,
    runs,
    periods,
    personaNames: new Map(personaFacts.map((p) => [p.id, p.name])),
    communityNames: new Map(communityRows.map((c) => [c.id, c.name])),
  };
}

export async function buildReport(
  db: Db,
  scenario: Scenario,
  record: RunRecord,
): Promise<SimulationReport> {
  const { input, decisions, runs, periods, personaNames, communityNames } = await loadFacts(
    db,
    scenario,
    record,
  );
  const checks = evaluateChecks(input);
  const { config } = scenario;

  // Published and quarantined per Belgrade day and kind, against the maxima.
  const perDayCounts = new Map<string, { published: number; quarantined: number }>();
  for (const d of decisions) {
    if (!isExecuted(d)) continue;
    const key = `${belgradeDayKey(d.createdAt)}|${d.kind}`;
    const entry = perDayCounts.get(key) ?? { published: 0, quarantined: 0 };
    entry[d.outcome as "published" | "quarantined"] += 1;
    perDayCounts.set(key, entry);
  }
  const perDay = [...perDayCounts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      const [day = "", kind = ""] = key.split("|");
      const max =
        kind === "summary"
          ? config.content.maxSummariesPerDay
          : dailyMaxFor(kind as "thread" | "reply" | "revision" | "vote", config.content);
      return { day, kind, ...value, max };
    });

  // Per simulated hour, labelled in Belgrade time.
  const outage = input.outageWindow;
  const pause = input.pauseWindow;
  const hourly: SimulationReport["hourly"] = [];
  for (let i = 0; i < scenario.hours; i += 1) {
    const from = new Date(scenario.start.getTime() + i * HOUR);
    const to = new Date(from.getTime() + HOUR);
    const here = decisions.filter((d) => d.createdAt >= from && d.createdAt < to);
    const done = decisions.filter(
      (d) => d.completedAt && d.completedAt >= from && d.completedAt < to,
    );
    const ranHere = runs.filter((r) => r.tickAt >= from && r.tickAt < to);
    const worst = ranHere.reduce<BudgetStage | null>((acc, r) => {
      const order: BudgetStage[] = ["normal", "reduced", "minimal", "paused"];
      return acc === null || order.indexOf(r.stage) > order.indexOf(acc) ? r.stage : acc;
    }, null);
    const notes: string[] = [];
    if (outage && from >= outage.from && from < outage.to) notes.push("worker down");
    if (pause && from >= pause.from && from < pause.to) notes.push("forum paused");
    hourly.push({
      index: i,
      belgrade: belgradeLabel(from),
      planned: here.length,
      published: done.filter((d) => d.outcome === "published").length,
      quarantined: done.filter((d) => d.outcome === "quarantined").length,
      skipped: done.filter((d) => d.outcome === "skipped").length,
      failed: done.filter((d) => d.outcome === "failed").length,
      stage: worst,
      note: notes.join(", "),
    });
  }

  const stageTransitions: SimulationReport["stageTransitions"] = [];
  let previous: BudgetStage | null = null;
  for (const r of runs) {
    if (previous !== null && r.stage !== previous) {
      stageTransitions.push({ at: iso(r.tickAt), from: previous, to: r.stage });
    }
    previous = r.stage;
  }

  const ambiguousRows = await db.execute<{ day: string; n: number; micros: number }>(sql`
    select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as day,
           count(*)::int as n, coalesce(sum(estimated_micros), 0)::bigint as micros
    from provider_requests where status = 'ambiguous' group by 1`);
  const ambiguousByDay = new Map(
    ambiguousRows.rows.map((r) => [r.day, { n: Number(r.n), micros: Number(r.micros) }]),
  );
  const budgetDays = periods
    .filter((p) => p.kind === "day")
    .map((p) => {
      const day = p.start.toISOString().slice(0, 10);
      const amb = ambiguousByDay.get(day) ?? { n: 0, micros: 0 };
      return {
        day,
        limitUsd: usd(p.limitMicros),
        spentUsd: usd(p.spentMicros),
        reservedUsd: usd(p.reservedMicros),
        ambiguousCalls: amb.n,
        ambiguousUsd: usd(amb.micros),
      };
    });

  const callRows = await db.execute<{ purpose: string; status: string; n: number }>(
    sql`select purpose, status, count(*)::int as n from provider_requests group by 1, 2 order by 1, 2`,
  );
  const providerCalls = callRows.rows.map((r) => ({
    purpose: r.purpose,
    status: r.status,
    count: Number(r.n),
  }));

  const outcomes: Record<string, number> = {};
  const skippedByCode: Record<string, number> = {};
  for (const d of decisions) {
    outcomes[d.outcome] = (outcomes[d.outcome] ?? 0) + 1;
    if (d.outcome === "skipped") {
      const code = d.code ?? "none";
      skippedByCode[code] = (skippedByCode[code] ?? 0) + 1;
    }
  }

  const newThreads = input.content.filter((c) => c.isThread && c.createdAt >= scenario.start);
  const newComments = input.content.filter((c) => !c.isThread && c.createdAt >= scenario.start);
  const byCommunity = groupCount(newThreads, (c) => c.communityId ?? "none");
  const byAuthor = groupCount(newComments, (c) => c.authorId);
  const top = (m: Map<string, number>): string | null =>
    [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const topCommunityId = top(byCommunity);
  const topPersonaId = top(byAuthor);

  return {
    scenario: {
      name: scenario.name,
      start: iso(scenario.start),
      end: iso(record.end),
      hours: scenario.hours,
      tickMinutes: scenario.tickMinutes,
      seed: scenario.seed,
      dailyLimitUsd: config.budget.dailyVariableSpendLimit,
      loweredLimit: scenario.lowerDailyLimit,
      limitCutHour: scenario.cutDailyLimitHour,
      workerOutage: scenario.workerOutage,
      forumPause: scenario.forumPause,
    },
    wallClockSeconds: Math.round(record.wallMs / 100) / 10,
    ticks: { run: record.ticksRun, skippedForOutage: record.ticksSkippedForOutage },
    perDay,
    hourly,
    stageTransitions,
    budgetDays,
    providerCalls,
    jobs: record.queue,
    outcomes,
    skippedByCode,
    faults: record.faults,
    scriptedFailureKeys: record.scriptedFailureKeys,
    repairs: {
      calls: input.repairCalls,
      actions: input.repairKeys,
      quarantined: input.quarantinedDecisions,
    },
    diversity: {
      communitiesWithNewThreads: byCommunity.size,
      communityCount: input.communityCount,
      topCommunityShare: topShare(byCommunity),
      topCommunity: topCommunityId
        ? (communityNames.get(topCommunityId) ?? topCommunityId)
        : null,
      personasThatCommented: byAuthor.size,
      personaCount: input.personas.length,
      topPersonaShare: topShare(byAuthor),
      topPersona: topPersonaId ? (personaNames.get(topPersonaId) ?? topPersonaId) : null,
      newThreads: newThreads.length,
      newComments: newComments.length,
    },
    cleanup: record.cleanup,
    events: record.events.map((e) => ({ at: iso(e.at), text: e.text })),
    checks,
    violations: violationsOf(checks),
  };
}

const pct = (n: number): string => `${(n * 100).toFixed(1)} %`;

function statusMark(c: CheckResult): string {
  return c.status === "pass" ? "ok  " : c.status === "fail" ? "FAIL" : "n/a ";
}

/** What `npm run sim:48h` prints. */
export function consoleSummary(r: SimulationReport): string {
  const lines: string[] = [];
  const s = r.scenario;
  lines.push(
    `Simulation "${s.name}": ${s.hours} h from ${s.start}, ${s.tickMinutes}-minute ticks, seed ${s.seed}`,
  );
  lines.push(
    `Ticks run ${r.ticks.run} (skipped for the outage ${r.ticks.skippedForOutage}), wall clock ${r.wallClockSeconds} s`,
  );
  lines.push(
    `Decisions: ${Object.entries(r.outcomes)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}`,
  );
  lines.push(
    `Skipped by code: ${
      Object.entries(r.skippedByCode)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ") || "none"
    }`,
  );
  lines.push(
    `Jobs: sent ${r.jobs.sent}, completed ${r.jobs.completed}, retries ${r.jobs.retries}, dead letters ${r.jobs.deadLetters}, peak pending ${r.jobs.maxPending}`,
  );
  lines.push(
    `Faults injected: ${r.faults.transient} transient, ${r.faults.ambiguous} ambiguous, ${r.faults.permanent} scripted, of ${r.faults.calls} generation calls`,
  );
  lines.push(
    `Bad drafts injected: ${r.faults.badDrafts} first drafts, ${r.faults.badRepairs} repairs; repairs paid ${r.repairs.calls} over ${r.repairs.actions} actions, quarantined decisions ${r.repairs.quarantined}`,
  );
  if (s.limitCutHour !== null) {
    lines.push(
      `Daily-limit cut at hour ${s.limitCutHour}: the owner lowers the daily limit to the amount spent so far, which shows the paused stage; spending in the minimal stage slows to a trickle on its own.`,
    );
  }
  lines.push("Published / quarantined per Belgrade day (maximum):");
  for (const d of r.perDay) {
    lines.push(`  ${d.day} ${d.kind.padEnd(8)} ${d.published}/${d.quarantined} (${d.max})`);
  }
  lines.push("Budget per UTC day:");
  for (const b of r.budgetDays) {
    lines.push(
      `  ${b.day} limit USD ${b.limitUsd.toFixed(4)}, spent ${b.spentUsd.toFixed(4)}, reserved ${b.reservedUsd.toFixed(4)}, ambiguous ${b.ambiguousCalls} calls (USD ${b.ambiguousUsd.toFixed(4)})`,
    );
  }
  lines.push(
    `Stage transitions: ${
      r.stageTransitions.map((t) => `${t.at.slice(5, 16)}Z ${t.from}>${t.to}`).join(", ") ||
      "none"
    }`,
  );
  lines.push(
    `Provider calls: ${r.providerCalls.map((c) => `${c.purpose}/${c.status} ${c.count}`).join(", ")}`,
  );
  const d = r.diversity;
  lines.push(
    `Diversity: ${d.communitiesWithNewThreads}/${d.communityCount} communities got new threads (top ${d.topCommunity ?? "-"} ${pct(d.topCommunityShare)} of ${d.newThreads}); ${d.personasThatCommented}/${d.personaCount} personas commented (top ${d.topPersona ?? "-"} ${pct(d.topPersonaShare)} of ${d.newComments} comments)`,
  );
  lines.push(
    `Cleanup: ${
      Object.entries(r.cleanup.runs)
        .map(
          ([k, n]) =>
            `${k} x${n} ${JSON.stringify(r.cleanup.totals[k] ?? {}).replaceAll('"', "")}`,
        )
        .join("; ") || "none"
    }`,
  );
  lines.push("Checks:");
  for (const c of r.checks) {
    lines.push(`  [${statusMark(c)}] ${String(c.id).padStart(2)} ${c.name}: ${c.detail}`);
  }
  lines.push(
    r.violations.length === 0
      ? "Violations: none, every promise held."
      : `Violations (${r.violations.length}):\n${r.violations.map((v) => `  - ${v}`).join("\n")}`,
  );
  return lines.join("\n");
}

/** The report the owner reads: the same facts as tables. */
export function markdownSummary(r: SimulationReport): string {
  const s = r.scenario;
  const out: string[] = [];
  out.push(`# Simulation ${s.name}`);
  out.push("");
  out.push(
    `${s.hours} simulated hours from ${s.start} (Monday 05:00 in Belgrade), ${s.tickMinutes}-minute ticks, seed \`${s.seed}\`. Wall clock ${r.wallClockSeconds} s. ${r.violations.length === 0 ? "**Every promise held.**" : `**${r.violations.length} violation(s).**`}`,
  );
  out.push("");
  out.push("## Checks");
  out.push("");
  out.push("| # | Check | Result | Detail |");
  out.push("|---|---|---|---|");
  for (const c of r.checks) {
    out.push(`| ${c.id} | ${c.name} | ${c.status} | ${c.detail.replaceAll("|", "/")} |`);
  }
  if (r.violations.length > 0) {
    out.push("");
    out.push("## Violations");
    out.push("");
    for (const v of r.violations) out.push(`- ${v}`);
  }
  out.push("");
  out.push("## Content per Belgrade day");
  out.push("");
  out.push("| Day | Kind | Published | Quarantined | Maximum |");
  out.push("|---|---|---|---|---|");
  for (const d of r.perDay) {
    out.push(`| ${d.day} | ${d.kind} | ${d.published} | ${d.quarantined} | ${d.max} |`);
  }
  out.push("");
  out.push("## Activity per hour (Belgrade time)");
  out.push("");
  out.push("| Hour | Planned | Published | Quarantined | Skipped | Failed | Stage | Note |");
  out.push("|---|---|---|---|---|---|---|---|");
  for (const h of r.hourly) {
    out.push(
      `| ${h.belgrade} | ${h.planned} | ${h.published} | ${h.quarantined} | ${h.skipped} | ${h.failed} | ${h.stage ?? "-"} | ${h.note} |`,
    );
  }
  out.push("");
  out.push("## Budget");
  out.push("");
  out.push(
    "| UTC day | Limit USD | Spent USD | Reserved USD | Ambiguous calls | Ambiguous USD |",
  );
  out.push("|---|---|---|---|---|---|");
  for (const b of r.budgetDays) {
    out.push(
      `| ${b.day} | ${b.limitUsd.toFixed(4)} | ${b.spentUsd.toFixed(4)} | ${b.reservedUsd.toFixed(4)} | ${b.ambiguousCalls} | ${b.ambiguousUsd.toFixed(4)} |`,
    );
  }
  out.push("");
  out.push("Stage transitions:");
  out.push("");
  for (const t of r.stageTransitions) out.push(`- ${t.at}: ${t.from} to ${t.to}`);
  if (r.stageTransitions.length === 0) out.push("- none");
  out.push("");
  out.push("## Provider calls");
  out.push("");
  out.push("| Purpose | Status | Count |");
  out.push("|---|---|---|");
  for (const c of r.providerCalls) out.push(`| ${c.purpose} | ${c.status} | ${c.count} |`);
  out.push("");
  out.push("## Jobs and outcomes");
  out.push("");
  out.push(
    `Jobs sent ${r.jobs.sent}, completed ${r.jobs.completed}, retries ${r.jobs.retries}, dead letters ${r.jobs.deadLetters}, peak pending ${r.jobs.maxPending}.`,
  );
  out.push("");
  out.push(
    `Decisions: ${Object.entries(r.outcomes)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}. Skipped by code: ${
      Object.entries(r.skippedByCode)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ") || "none"
    }.`,
  );
  out.push("");
  out.push(
    `Faults: ${r.faults.transient} transient, ${r.faults.ambiguous} ambiguous, ${r.faults.permanent} scripted failures, of ${r.faults.calls} generation calls.`,
  );
  out.push("");
  out.push(
    `Bad drafts: ${r.faults.badDrafts} first drafts and ${r.faults.badRepairs} repairs came back English. Paid repairs: ${r.repairs.calls} over ${r.repairs.actions} actions; ${r.repairs.quarantined} decisions ended quarantined.`,
  );
  out.push("");
  if (s.limitCutHour !== null) {
    out.push(
      `Daily-limit cut at hour ${s.limitCutHour}: the owner lowers the daily limit to the amount spent so far, which shows the paused stage. Spending in the minimal stage slows to a trickle on its own, so it does not reach the paused stage by itself.`,
    );
    out.push("");
  }
  out.push("## Diversity");
  out.push("");
  const d = r.diversity;
  out.push(
    `${d.communitiesWithNewThreads} of ${d.communityCount} communities got new threads (top: ${d.topCommunity ?? "-"}, ${pct(d.topCommunityShare)} of ${d.newThreads}). ${d.personasThatCommented} of ${d.personaCount} personas commented (top: ${d.topPersona ?? "-"}, ${pct(d.topPersonaShare)} of ${d.newComments}).`,
  );
  out.push("");
  out.push("## Cleanup");
  out.push("");
  for (const [k, n] of Object.entries(r.cleanup.runs)) {
    out.push(`- ${k}: ${n} runs, ${JSON.stringify(r.cleanup.totals[k] ?? {})}`);
  }
  out.push("");
  out.push("## Events");
  out.push("");
  for (const e of r.events) out.push(`- ${e.at}: ${e.text}`);
  out.push("");
  return out.join("\n");
}
