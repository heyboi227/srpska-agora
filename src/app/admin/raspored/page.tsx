import type { Metadata } from "next";
import Link from "next/link";
import { Breakdown } from "@/components/admin/breakdown";
import { TableScroll, TD, TH, TR } from "@/components/admin/table-scroll";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ManualClock, systemClock } from "@/lib/clock";
import { getActiveConfig } from "@/lib/config/service";
import { getBudgetStatus, STAGE_EXPLANATIONS, STAGE_LABELS } from "@/lib/costs";
import { getDb } from "@/lib/db/client";
import type { ActionKind } from "@/lib/jobs/types";
import { listWorkerHeartbeats } from "@/lib/queries/admin";
import {
  describeTarget,
  INTENT_LABELS,
  KIND_LABELS,
  listRecentDecisions,
  listRecentRuns,
  OUTCOME_LABELS,
  resolveTargets,
  RUN_STATE_LABELS,
} from "@/lib/queries/scheduler";
import { previewSchedulerTick } from "@/lib/scheduler";
import { belgradeHour, formatBelgradeDateTime, formatRelative } from "@/lib/time";
import { requireAdmin } from "@/server/auth";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Raspored", robots: { index: false } };

const KINDS: ActionKind[] = ["thread", "reply", "revision", "summary", "vote"];
const MAX_PREVIEW_OFFSET_MS = 30 * 24 * 3_600_000;
const EXPLICIT_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;

const number = new Intl.NumberFormat("sr-Latn-RS", { maximumFractionDigits: 3 });

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function parsePreviewTime(
  raw: string | string[] | undefined,
  now: Date,
): { at: Date | null; notice: string | null } {
  if (raw === undefined || raw === "") return { at: null, notice: null };
  const value = Array.isArray(raw) ? raw[0] : raw;
  const fallback = "Uneto vreme nije prihvaćeno; prikazan je pregled za sadašnji trenutak.";
  if (!value || !EXPLICIT_OFFSET.test(value.trim())) {
    return {
      at: null,
      notice: `${fallback} Vreme mora biti u ISO obliku sa zonom, na primer 2026-11-02T10:00:00+01:00.`,
    };
  }
  const at = new Date(value.trim());
  if (Number.isNaN(at.getTime())) return { at: null, notice: fallback };
  if (Math.abs(at.getTime() - now.getTime()) > MAX_PREVIEW_OFFSET_MS) {
    return {
      at: null,
      notice: `${fallback} Dozvoljeno je najviše 30 dana od sada, unapred ili unazad.`,
    };
  }
  return { at, notice: null };
}

function emptyReason(
  kind: ActionKind,
  expected: number,
  stage: string,
  pauseAll: boolean,
  hour: number,
): string {
  if (pauseAll) return "Sve akcije su pauzirane, pa se ništa ne planira.";
  if (stage === "paused" && kind !== "vote") {
    return "Budžet je u fazi pauze, pa plaćeni rad nije dozvoljen.";
  }
  if (expected === 0) {
    return "Za ovu vrstu nema predviđenih mesta u ovom satu: dnevni maksimum je dostignut ili nema dospelog posla.";
  }
  return `Nema kandidata: u ${hour}:00 sagovornici možda nisu aktivni, ili nijedan cilj ne ispunjava uslove (pauze, ograničenja ponavljanja).`;
}

const EMPTY_BOX =
  "rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-text-muted";

export default async function SchedulePage(props: { searchParams: SearchParams }) {
  await requireAdmin();
  const searchParams = await props.searchParams;
  const db = getDb();
  const realNow = new Date();
  const { at, notice } = parsePreviewTime(searchParams.vreme, realNow);
  const clock = at ? new ManualClock(at) : systemClock;
  const previewAt = clock.now();

  const config = await getActiveConfig(db);
  const [status, preview, runs, decisions, heartbeats] = await Promise.all([
    getBudgetStatus(db, config, systemClock),
    previewSchedulerTick({ db, config, clock, queue: null }),
    listRecentRuns(db, 20),
    listRecentDecisions(db, 30),
    listWorkerHeartbeats(db, realNow),
  ]);
  const refs = KINDS.flatMap((k) => preview.topCandidates[k]).map((c) => ({
    threadId: c.threadId,
    targetId: c.targetId,
    targetType: c.targetType,
  }));
  const resolved = await resolveTargets(db, refs);
  const heartbeat = heartbeats[0] ?? null;
  const hour = belgradeHour(previewAt);

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-2xl font-semibold">Raspored</h1>
        <p className="mt-1 max-w-3xl text-sm text-text-muted">
          Šta raspoređivač radi i zašto. Pregled ne upisuje ništa i ne pokreće nijedan posao.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Stanje</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={config.runtime.pauseAllActions ? "danger" : "ok"}>
              {config.runtime.pauseAllActions ? "Sve akcije pauzirane" : "Akcije aktivne"}
            </Badge>
            <Badge variant={config.runtime.pausePaidActions ? "warn" : "ok"}>
              {config.runtime.pausePaidActions
                ? "Plaćene akcije pauzirane"
                : "Plaćene akcije dozvoljene"}
            </Badge>
            <Badge variant={status.stage === "normal" ? "ok" : "warn"}>
              Budžetska faza: {STAGE_LABELS[status.stage]}
            </Badge>
          </div>
          <p className="text-text-muted">{STAGE_EXPLANATIONS[status.stage]}</p>
          <p>
            Radnik:{" "}
            {heartbeat ? (
              <span>
                poslednji signal {formatRelative(heartbeat.lastSeenAt, realNow)} (
                {formatBelgradeDateTime(heartbeat.lastSeenAt)})
                {heartbeat.stale ? " · zastareo" : ""}
              </span>
            ) : (
              <span className="text-text-muted">još nema signala.</span>
            )}
          </p>
        </CardContent>
      </Card>

      <section aria-labelledby="pregled" className="flex flex-col gap-3">
        <h2 id="pregled" className="text-lg font-semibold">
          Pregled sledećeg kruga
        </h2>
        <form method="get" className="flex flex-wrap items-end gap-2 text-sm">
          <div className="flex flex-col gap-1">
            <label htmlFor="vreme" className="text-xs text-text-muted">
              Pregled za drugo vreme (ISO, sa zonom)
            </label>
            <input
              id="vreme"
              name="vreme"
              defaultValue={at ? at.toISOString() : ""}
              placeholder="2026-11-02T10:00:00+01:00"
              className="h-8 w-72 max-w-full rounded-md border border-border bg-bg px-2 text-xs"
            />
          </div>
          <Button type="submit" size="sm" variant="secondary">
            Prikaži
          </Button>
          {at && (
            <Link href="/admin/raspored" className="text-xs">
              Vrati na sada
            </Link>
          )}
        </form>
        {notice && (
          <p role="status" className="rounded-md border border-warn/50 px-3 py-2 text-sm">
            {notice}
          </p>
        )}
        <p className="text-sm text-text-muted">
          Pregled važi za {formatBelgradeDateTime(previewAt)}
          {at ? " (zadato vreme)" : " (sada)"}; faza budžeta: {STAGE_LABELS[preview.stage]}.
        </p>

        <div className="flex flex-wrap gap-2">
          {KINDS.map((k) => (
            <Badge key={k}>
              {KIND_LABELS[k]}: očekivano {number.format(preview.slots[k].expected)}
            </Badge>
          ))}
        </div>

        {KINDS.map((kind) => {
          const list = preview.topCandidates[kind];
          return (
            <Card key={kind}>
              <CardHeader>
                <CardTitle>{KIND_LABELS[kind]}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm">
                {list.length === 0 ? (
                  <p className="text-text-muted">
                    {emptyReason(
                      kind,
                      preview.slots[kind].expected,
                      preview.stage,
                      config.runtime.pauseAllActions,
                      hour,
                    )}
                  </p>
                ) : (
                  <ol className="flex flex-col gap-3">
                    {list.map((c, i) => {
                      const target = describeTarget(resolved, c);
                      return (
                        <li
                          key={`${c.actionKey}-${i}`}
                          className="flex flex-col gap-1 border-t border-border pt-3 first:border-t-0 first:pt-0"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{c.personaName ?? "—"}</span>
                            {c.intent && <Badge>{INTENT_LABELS[c.intent] ?? c.intent}</Badge>}
                            {kind === "vote" && c.voteValue !== null && (
                              <Badge>{c.voteValue > 0 ? "za" : "protiv"}</Badge>
                            )}
                            <span className="text-text-muted">
                              ocena {number.format(c.score)}
                            </span>
                          </div>
                          <p className="break-words">
                            {target.href ? (
                              <Link href={target.href}>{target.label}</Link>
                            ) : (
                              target.label
                            )}
                          </p>
                          <Breakdown breakdown={c.breakdown} />
                        </li>
                      );
                    })}
                  </ol>
                )}
              </CardContent>
            </Card>
          );
        })}
      </section>

      <section aria-labelledby="krugovi" className="flex flex-col gap-2">
        <h2 id="krugovi" className="text-lg font-semibold">
          Poslednji krugovi
        </h2>
        {runs.length === 0 ? (
          <p className={EMPTY_BOX}>Još nema zabeleženih krugova.</p>
        ) : (
          <TableScroll label="Poslednji krugovi">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr>
                  <th className={TH}>Vreme</th>
                  <th className={TH}>Stanje</th>
                  <th className={TH}>Faza</th>
                  <th className={TH}>Planirano</th>
                  <th className={TH}>Kandidata</th>
                  <th className={TH}>Prazna mesta</th>
                  <th className={TH}>Trajanje</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className={TR}>
                    <td className={`${TD} whitespace-nowrap`}>
                      {formatBelgradeDateTime(r.tickAt)}
                    </td>
                    <td className={TD}>{RUN_STATE_LABELS[r.state] ?? r.state}</td>
                    <td className={TD}>
                      {STAGE_LABELS[r.budgetStage as keyof typeof STAGE_LABELS] ??
                        r.budgetStage}
                    </td>
                    <td className={TD}>{r.plannedCount}</td>
                    <td className={TD}>{r.candidateCount}</td>
                    <td className={TD}>{r.idleSlots ?? "—"}</td>
                    <td className={TD}>{r.durationMs === null ? "—" : `${r.durationMs} ms`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </section>

      <section aria-labelledby="odluke" className="flex flex-col gap-2">
        <h2 id="odluke" className="text-lg font-semibold">
          Poslednje odluke
        </h2>
        {decisions.length === 0 ? (
          <p className={EMPTY_BOX}>Još nema zabeleženih odluka.</p>
        ) : (
          <TableScroll label="Poslednje odluke">
            <table className="w-full min-w-[56rem] text-sm">
              <thead>
                <tr>
                  <th className={TH}>Vreme</th>
                  <th className={TH}>Vrsta</th>
                  <th className={TH}>Sagovornik</th>
                  <th className={TH}>Cilj</th>
                  <th className={TH}>Ocena</th>
                  <th className={TH}>Ishod</th>
                  <th className={TH}>Rezultat</th>
                  <th className={TH}>Rastavljanje</th>
                </tr>
              </thead>
              <tbody>
                {decisions.map((d) => (
                  <tr key={d.id} className={TR}>
                    <td className={`${TD} whitespace-nowrap`}>
                      {formatBelgradeDateTime(d.createdAt)}
                    </td>
                    <td className={TD}>{KIND_LABELS[d.kind] ?? d.kind}</td>
                    <td className={TD}>{d.personaName ?? "—"}</td>
                    <td className={`${TD} max-w-64 break-words`}>
                      {d.target.href ? (
                        <Link href={d.target.href}>{d.target.label}</Link>
                      ) : (
                        d.target.label
                      )}
                    </td>
                    <td className={TD}>{number.format(d.score)}</td>
                    <td className={TD}>
                      {OUTCOME_LABELS[d.outcome] ?? d.outcome}
                      {d.outcomeCode && (
                        <span className="ml-1 font-mono text-xs text-text-muted">
                          {d.outcomeCode}
                        </span>
                      )}
                    </td>
                    <td className={TD}>
                      {d.resultHref ? <Link href={d.resultHref}>otvori</Link> : "—"}
                    </td>
                    <td className={TD}>
                      <Breakdown breakdown={d.breakdown} summary="Prikaži" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </section>
    </div>
  );
}
