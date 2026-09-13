import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getActiveConfig, getActiveConfigRevision } from "@/lib/config/service";
import { getDb } from "@/lib/db/client";
import { getEnv } from "@/lib/env";
import { createProviders, describeProviders } from "@/lib/providers";
import {
  getDashboardCounts,
  listRecentActions,
  listWorkerHeartbeats,
} from "@/lib/queries/admin";
import { formatBelgradeDateTime, formatRelative } from "@/lib/time";
import { requireAdmin } from "@/server/auth";
import { applyPresetAction, setPauseAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Administracija", robots: { index: false } };

const STATUS_VARIANT: Record<string, "ok" | "warn" | "danger" | "default"> = {
  published: "ok",
  quarantined: "warn",
  rejected: "danger",
  failed: "danger",
  proposed: "default",
  validated: "default",
};

export default async function AdminDashboard() {
  await requireAdmin();
  const db = getDb();
  const [config, revision, counts, actions, heartbeats] = await Promise.all([
    getActiveConfig(db),
    getActiveConfigRevision(db),
    getDashboardCounts(db),
    listRecentActions(db, 25),
    listWorkerHeartbeats(db),
  ]);
  const providers = describeProviders(
    createProviders(config.runtime.mode, { openaiApiKey: getEnv().OPENAI_API_KEY }),
  );

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Pregled</h1>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Stanje foruma</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={config.runtime.pauseAllActions ? "danger" : "ok"}>
                {config.runtime.pauseAllActions ? "Sve akcije pauzirane" : "Akcije aktivne"}
              </Badge>
              <Badge variant={config.runtime.pausePaidActions ? "warn" : "ok"}>
                {config.runtime.pausePaidActions
                  ? "Plaćene akcije pauzirane"
                  : "Plaćene akcije dozvoljene"}
              </Badge>
              <Badge>režim: {config.runtime.mode}</Badge>
              <Badge>preset: {config.preset}</Badge>
              <Badge>revizija {revision?.revision ?? "—"}</Badge>
            </div>
            <div className="flex flex-wrap gap-2">
              <form action={setPauseAction}>
                <input type="hidden" name="field" value="pauseAllActions" />
                <input
                  type="hidden"
                  name="value"
                  value={String(!config.runtime.pauseAllActions)}
                />
                <Button
                  type="submit"
                  size="sm"
                  variant={config.runtime.pauseAllActions ? "secondary" : "danger"}
                >
                  {config.runtime.pauseAllActions
                    ? "Nastavi sve akcije"
                    : "Pauziraj sve akcije"}
                </Button>
              </form>
              <form action={setPauseAction}>
                <input type="hidden" name="field" value="pausePaidActions" />
                <input
                  type="hidden"
                  name="value"
                  value={String(!config.runtime.pausePaidActions)}
                />
                <Button type="submit" size="sm" variant="secondary">
                  {config.runtime.pausePaidActions
                    ? "Dozvoli plaćene akcije"
                    : "Pauziraj samo plaćene akcije"}
                </Button>
              </form>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-text-muted">Preset:</span>
              {(["quiet", "standard"] as const).map((preset) => (
                <form key={preset} action={applyPresetAction}>
                  <input type="hidden" name="preset" value={preset} />
                  <Button
                    type="submit"
                    size="sm"
                    variant={config.preset === preset ? "default" : "secondary"}
                    disabled={config.preset === preset}
                  >
                    {preset === "quiet" ? "tihi" : "standardni"}
                  </Button>
                </form>
              ))}
            </div>
            <p className="text-xs text-text-muted">
              Pauza zaustavlja nove akcije sagovornika, uključujući već zakazane. Moderacija
              radi i tokom pauze.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Provajderi</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <dl className="grid grid-cols-[120px_1fr] gap-1">
              {(["generation", "validation", "search"] as const).map((capability) => (
                <div key={capability} className="contents">
                  <dt className="text-text-muted">
                    {capability === "generation"
                      ? "Generisanje"
                      : capability === "validation"
                        ? "Validacija"
                        : "Pretraga vesti"}
                  </dt>
                  <dd>
                    {providers[capability].name}{" "}
                    <Badge variant={providers[capability].configured ? "ok" : "warn"}>
                      {providers[capability].configured
                        ? "konfigurisano"
                        : "nije konfigurisano"}
                    </Badge>
                  </dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-xs text-text-muted">
              Budžet: {config.budget.dailyVariableSpendLimit} {config.budget.accountingCurrency}{" "}
              dnevno, {config.budget.monthlyVariableSpendLimit}{" "}
              {config.budget.accountingCurrency} mesečno. Merenje potrošnje stiže u fazi 2.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Radnik (worker)</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {heartbeats.length === 0 ? (
              <p className="text-text-muted">
                Nijedan radnik se još nije prijavio. Pokrenite <code>npm run dev:worker</code>.
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {heartbeats.map((hb) => {
                  return (
                    <li key={hb.workerId} className="flex flex-wrap items-center gap-2">
                      <Badge variant={hb.stale ? "danger" : "ok"}>
                        {hb.stale ? "ne odgovara" : "aktivan"}
                      </Badge>
                      <span className="font-mono text-xs">{hb.workerId}</span>
                      <span className="text-text-muted">
                        viđen {formatRelative(hb.lastSeenAt)}
                      </span>
                      <span className="text-text-muted">v{hb.version}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="xl:col-span-3">
          <CardHeader>
            <CardTitle>Brojke</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
              <Stat label="Objavljene teme" value={counts.threadsPublished} />
              <Stat label="Objavljeni komentari" value={counts.commentsPublished} />
              <Stat
                label="Sagovornici"
                value={`${counts.personas}${counts.personasSuspended ? ` (${counts.personasSuspended} suspendovano)` : ""}`}
              />
              <Stat label="Zajednice" value={counts.communities} />
              <Stat label="U karantinu" value={counts.quarantined} href="/admin/karantin" />
              <Stat
                label="Sakriveno"
                value={counts.threadsHidden + counts.commentsHidden}
                href="/admin/sadrzaj"
              />
              <Stat label="Akcija u 24 h" value={counts.actionsLast24h} />
              <Stat
                label="Konfiguracija"
                value={`rev. ${revision?.revision ?? "—"}`}
                href="/admin/konfiguracija"
              />
            </dl>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Poslednje akcije</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="text-xs text-text-muted">
              <tr>
                <th className="py-1 pr-3 font-medium">Vreme</th>
                <th className="py-1 pr-3 font-medium">Tip</th>
                <th className="py-1 pr-3 font-medium">Sagovornik</th>
                <th className="py-1 pr-3 font-medium">Status</th>
                <th className="py-1 pr-3 font-medium">Kodovi odluke</th>
                <th className="py-1 pr-3 font-medium">Rezultat</th>
              </tr>
            </thead>
            <tbody>
              {actions.map((action) => (
                <tr key={action.id} className="border-t border-border align-top">
                  <td
                    className="py-1.5 pr-3 whitespace-nowrap text-text-muted"
                    title={formatBelgradeDateTime(action.createdAt)}
                  >
                    {formatRelative(action.createdAt)}
                  </td>
                  <td className="py-1.5 pr-3">
                    {action.actionType}
                    {action.intent && (
                      <span className="text-text-muted"> · {action.intent}</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3">
                    {action.personaSlug ? (
                      <Link href={`/a/${action.personaSlug}`}>{action.personaName}</Link>
                    ) : (
                      <span className="text-text-muted">sistem</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3">
                    <Badge variant={STATUS_VARIANT[action.status] ?? "default"}>
                      {action.status}
                    </Badge>
                    {action.attempt > 1 && (
                      <span className="ml-1 text-xs text-text-muted">
                        pokušaj {action.attempt}
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 text-xs">
                    {action.decisionCodes.join(", ") || "—"}
                  </td>
                  <td className="py-1.5 pr-3 text-xs">
                    {action.threadId && action.status === "published" ? (
                      <Link
                        href={
                          action.actionType === "reply" && action.resultId
                            ? `/t/${action.threadId}/k/${action.resultId}`
                            : `/t/${action.threadId}`
                        }
                      >
                        otvori
                      </Link>
                    ) : action.status === "quarantined" ? (
                      <Link href="/admin/karantin">karantin</Link>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({
  label,
  value,
  href,
}: {
  label: string;
  value: string | number;
  href?: string;
}) {
  return (
    <div>
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className="text-lg font-semibold">
        {href ? (
          <Link href={href} className="text-text no-underline hover:underline">
            {value}
          </Link>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}
