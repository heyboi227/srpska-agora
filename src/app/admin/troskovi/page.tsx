import type { Metadata } from "next";
import { TableScroll, TD, TH, TR } from "@/components/admin/table-scroll";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { systemClock } from "@/lib/clock";
import { getActiveConfig } from "@/lib/config/service";
import {
  getBudgetStatus,
  PRICE_TABLE,
  STAGE_EXPLANATIONS,
  STAGE_LABELS,
  type PeriodStatus,
} from "@/lib/costs";
import { getDb } from "@/lib/db/client";
import {
  formatMicrosUsd,
  listRecentProviderRequests,
  ORIGIN_LABELS,
  PURPOSE_LABELS,
  REJECT_REASON_LABELS,
  REQUEST_STATUS_LABELS,
} from "@/lib/queries/costs";
import { formatBelgradeDateTime } from "@/lib/time";
import { requireAdmin } from "@/server/auth";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Troškovi", robots: { index: false } };

const STATUS_VARIANT: Record<string, "ok" | "warn" | "danger" | "default"> = {
  succeeded: "ok",
  failed: "danger",
  ambiguous: "warn",
  rejected: "warn",
  reserved: "default",
};

const tokens = new Intl.NumberFormat("sr-Latn-RS");
const rate = new Intl.NumberFormat("sr-Latn-RS", { maximumFractionDigits: 4 });

function PeriodCard({
  title,
  period,
  forecast,
  testId,
}: {
  title: string;
  period: PeriodStatus;
  forecast: number | null;
  testId: string;
}) {
  const rows: [string, string][] = [
    ["Granica", formatMicrosUsd(period.limitMicros)],
    ["Potrošeno", formatMicrosUsd(period.spentMicros)],
    ["Rezervisano (uključujući neizvesno)", formatMicrosUsd(period.reservedMicros)],
    ["Preostalo", formatMicrosUsd(period.remainingMicros)],
    [
      "Procena do kraja",
      forecast === null ? "još nema dovoljno podataka" : formatMicrosUsd(forecast),
    ],
  ];
  return (
    <Card data-testid={testId}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-text-muted">{label}</dt>
              <dd className="text-right tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

const nullable = (n: number | null) => (n === null ? "—" : tokens.format(n));

export default async function CostsPage() {
  await requireAdmin();
  const db = getDb();
  const config = await getActiveConfig(db);
  const [status, requests] = await Promise.all([
    getBudgetStatus(db, config, systemClock),
    listRecentProviderRequests(db, 50),
  ]);

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-2xl font-semibold">Troškovi</h1>
        <p className="mt-1 max-w-3xl text-sm text-text-muted">
          Potrošnja plaćenih poziva prema dnevnoj i mesečnoj granici. Pozivi lažnog (probnog)
          davaoca ne koštaju ništa i ne ulaze u ovaj zbir.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Budžetska faza</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={status.stage === "normal" ? "ok" : "warn"}>
              Faza: {STAGE_LABELS[status.stage]}
            </Badge>
            <Badge variant={status.pausePaidActions ? "warn" : "ok"}>
              {status.pausePaidActions
                ? "Plaćene akcije pauzirane"
                : "Plaćene akcije dozvoljene"}
            </Badge>
            <Badge>preset: {config.preset}</Badge>
          </div>
          <p className="text-text-muted">{STAGE_EXPLANATIONS[status.stage]}</p>
          {status.actionReserveMicros > 0 && (
            <p className="text-sm text-text-muted" data-testid="cost-reserve">
              Rezerva za jednu akciju: {formatMicrosUsd(status.actionReserveMicros)}. Kada
              preostalo stane ispod nje, plaćeni rad se zaustavlja.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <PeriodCard
          title="Danas"
          period={status.day}
          forecast={status.forecast.dayProjectedMicros}
          testId="cost-day"
        />
        <PeriodCard
          title="Ovaj mesec"
          period={status.month}
          forecast={status.forecast.monthProjectedMicros}
          testId="cost-month"
        />
      </div>
      {status.ambiguousCount > 0 && (
        <p role="status" className="rounded-md border border-warn/50 px-3 py-2 text-sm">
          Neizvesnih rezervacija: {status.ambiguousCount}. Poziv je možda stigao do davaoca, pa
          se rezervacija računa u celosti dok se ne uskladi sa stvarnim stanjem.
        </p>
      )}

      <section aria-labelledby="pozivi" className="flex flex-col gap-2">
        <h2 id="pozivi" className="text-lg font-semibold">
          Poslednjih 50 poziva
        </h2>
        {requests.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-text-muted">
            Još nema zabeleženih poziva davaocu.
          </p>
        ) : (
          <TableScroll label="Poslednji pozivi davaocu">
            <table className="w-full min-w-[64rem] text-sm">
              <thead>
                <tr>
                  <th className={TH}>Vreme</th>
                  <th className={TH}>Poreklo</th>
                  <th className={TH}>Svrha</th>
                  <th className={TH}>Davalac i model</th>
                  <th className={TH}>Status</th>
                  <th className={TH}>Ulaz</th>
                  <th className={TH}>Keširano</th>
                  <th className={TH}>Izlaz</th>
                  <th className={TH}>Rasuđivanje</th>
                  <th className={TH}>Procena</th>
                  <th className={TH}>Stvarno</th>
                  <th className={TH}>Kašnjenje</th>
                  <th className={TH}>Napomena</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.id} className={TR}>
                    <td className={`${TD} whitespace-nowrap`}>
                      {formatBelgradeDateTime(r.createdAt)}
                    </td>
                    <td className={TD}>{ORIGIN_LABELS[r.origin] ?? r.origin}</td>
                    <td className={TD}>{PURPOSE_LABELS[r.purpose] ?? r.purpose}</td>
                    <td className={`${TD} whitespace-nowrap`}>
                      {r.provider} / {r.model}
                    </td>
                    <td className={TD}>
                      <Badge variant={STATUS_VARIANT[r.status] ?? "default"}>
                        {REQUEST_STATUS_LABELS[r.status] ?? r.status}
                      </Badge>
                    </td>
                    <td className={TD}>{nullable(r.inputTokens)}</td>
                    <td className={TD}>{nullable(r.cachedInputTokens)}</td>
                    <td className={TD}>{nullable(r.outputTokens)}</td>
                    <td className={TD}>{nullable(r.reasoningTokens)}</td>
                    <td className={`${TD} whitespace-nowrap`}>
                      {formatMicrosUsd(r.estimatedMicros)}
                    </td>
                    <td className={`${TD} whitespace-nowrap`}>
                      {formatMicrosUsd(r.actualMicros)}
                    </td>
                    <td className={`${TD} whitespace-nowrap`}>
                      {r.latencyMs === null ? "—" : `${tokens.format(r.latencyMs)} ms`}
                    </td>
                    <td className={`${TD} max-w-64 break-words text-xs`}>
                      {r.rejectReason
                        ? (REJECT_REASON_LABELS[r.rejectReason] ?? r.rejectReason)
                        : r.error
                          ? r.error.slice(0, 160)
                          : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </section>

      <section aria-labelledby="cene" className="flex flex-col gap-2">
        <h2 id="cene" className="text-lg font-semibold">
          Cenovnik
        </h2>
        <p className="text-sm text-text-muted">
          Cene su u USD za milion tokena. Lažni davalac ne naplaćuje ništa; cenovnik važi samo
          za stvarne pozive.
        </p>
        <TableScroll label="Cenovnik modela">
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr>
                <th className={TH}>Model</th>
                <th className={TH}>Ulaz</th>
                <th className={TH}>Keširani ulaz</th>
                <th className={TH}>Izlaz</th>
                <th className={TH}>Po pozivu</th>
                <th className={TH}>Proveren</th>
                <th className={TH}>Izvor</th>
              </tr>
            </thead>
            <tbody>
              {PRICE_TABLE.map((p) => (
                <tr key={`${p.provider}/${p.model}`} className={TR}>
                  <td className={`${TD} whitespace-nowrap`}>
                    {p.provider} / {p.model}
                  </td>
                  <td className={TD}>{rate.format(p.inputPerMillionUsd)}</td>
                  <td className={TD}>{rate.format(p.cachedInputPerMillionUsd)}</td>
                  <td className={TD}>{rate.format(p.outputPerMillionUsd)}</td>
                  <td className={TD}>
                    {p.perCallUsd === undefined ? "—" : rate.format(p.perCallUsd)}
                  </td>
                  <td className={`${TD} whitespace-nowrap`}>{p.verifiedAt}</td>
                  <td className={`${TD} break-all text-xs`}>
                    <a href={p.source} target="_blank" rel="noreferrer">
                      izvor
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </section>
    </div>
  );
}
