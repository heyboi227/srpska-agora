import type { Metadata } from "next";
import { TableScroll, TD, TH, TR } from "@/components/admin/table-scroll";
import { getDb } from "@/lib/db/client";
import {
  countSkippedByCode,
  explainSkipCode,
  getQueueStats,
  listDeadLetterDecisions,
  QUEUE_GROUPS,
} from "@/lib/queries/jobs";
import { KIND_LABELS } from "@/lib/queries/scheduler";
import { formatBelgradeDateTime } from "@/lib/time";
import { requireAdmin } from "@/server/auth";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Poslovi", robots: { index: false } };

const EMPTY_BOX =
  "rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-text-muted";

export default async function JobsPage() {
  await requireAdmin();
  const db = getDb();
  const now = new Date();
  const [stats, dead, skipped] = await Promise.all([
    getQueueStats(db, now).catch(() => null),
    listDeadLetterDecisions(db, 30),
    countSkippedByCode(db, now),
  ]);
  const byName = new Map((stats ?? []).map((s) => [s.name, s]));

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-2xl font-semibold">Poslovi</h1>
        <p className="mt-1 max-w-3xl text-sm text-text-muted">
          Redovi poslova koje izvršava radnik. Brojevi dolaze direktno iz baze reda poslova.
        </p>
      </header>

      <section aria-labelledby="redovi" className="flex flex-col gap-2">
        <h2 id="redovi" className="text-lg font-semibold">
          Redovi
        </h2>
        {stats === null ? (
          <p role="status" className={EMPTY_BOX}>
            Radnik još nije pokrenut.
          </p>
        ) : (
          <TableScroll label="Redovi poslova">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr>
                  <th className={TH}>Grupa</th>
                  <th className={TH}>Red</th>
                  <th className={TH}>Čeka</th>
                  <th className={TH}>Ponovni pokušaj</th>
                  <th className={TH}>Aktivno</th>
                  <th className={TH}>Završeno (24 h)</th>
                  <th className={TH}>Neuspešno (24 h)</th>
                </tr>
              </thead>
              <tbody>
                {QUEUE_GROUPS.flatMap((g) =>
                  g.names.map((name) => {
                    const s = byName.get(name);
                    return (
                      <tr key={name} className={TR}>
                        <td className={TD}>{g.title}</td>
                        <td className={`${TD} font-mono text-xs`}>{name}</td>
                        <td className={TD}>{s?.created ?? 0}</td>
                        <td className={TD}>{s?.retry ?? 0}</td>
                        <td className={TD}>{s?.active ?? 0}</td>
                        <td className={TD}>{s?.completed24h ?? 0}</td>
                        <td className={TD}>{s?.failed24h ?? 0}</td>
                      </tr>
                    );
                  }),
                )}
              </tbody>
            </table>
          </TableScroll>
        )}
      </section>

      <section aria-labelledby="odrzavanje" className="flex flex-col gap-2">
        <h2 id="odrzavanje" className="text-lg font-semibold">
          Poslednje pokretanje poslova održavanja
        </h2>
        {stats === null ? (
          <p className={EMPTY_BOX}>Nema podataka dok se radnik ne pokrene.</p>
        ) : (
          <TableScroll label="Poslovi održavanja">
            <table className="w-full min-w-[28rem] text-sm">
              <thead>
                <tr>
                  <th className={TH}>Posao</th>
                  <th className={TH}>Poslednje uspešno izvršavanje</th>
                </tr>
              </thead>
              <tbody>
                {(QUEUE_GROUPS.find((g) => g.title === "Održavanje")?.names ?? []).map(
                  (name) => {
                    const s = byName.get(name);
                    return (
                      <tr key={name} className={TR}>
                        <td className={`${TD} font-mono text-xs`}>{name}</td>
                        <td className={TD}>
                          {s?.lastCompletedAt
                            ? formatBelgradeDateTime(s.lastCompletedAt)
                            : "još nije izvršen ili je zapis već obrisan"}
                        </td>
                      </tr>
                    );
                  },
                )}
              </tbody>
            </table>
          </TableScroll>
        )}
      </section>

      <section aria-labelledby="mrtvo" className="flex flex-col gap-2">
        <h2 id="mrtvo" className="text-lg font-semibold">
          Posao koji je odustao nakon svih pokušaja
        </h2>
        {dead.length === 0 ? (
          <p className={EMPTY_BOX}>Nijedan posao nije završio u mrtvom pismu.</p>
        ) : (
          <TableScroll label="Poslovi u mrtvom pismu">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr>
                  <th className={TH}>Vreme</th>
                  <th className={TH}>Vrsta</th>
                  <th className={TH}>Sagovornik</th>
                  <th className={TH}>Ključ akcije</th>
                  <th className={TH}>Greška</th>
                </tr>
              </thead>
              <tbody>
                {dead.map((d) => (
                  <tr key={d.id} className={TR}>
                    <td className={`${TD} whitespace-nowrap`}>
                      {formatBelgradeDateTime(d.createdAt)}
                    </td>
                    <td className={TD}>{KIND_LABELS[d.kind] ?? d.kind}</td>
                    <td className={TD}>{d.personaName ?? "—"}</td>
                    <td className={`${TD} break-all font-mono text-xs`}>{d.actionKey}</td>
                    <td className={`${TD} max-w-64 break-words text-xs`}>
                      {d.error ? d.error.slice(0, 300) : "nije zabeležena"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </section>

      <section aria-labelledby="preskoceno" className="flex flex-col gap-2">
        <h2 id="preskoceno" className="text-lg font-semibold">
          Preskočene odluke u poslednja 24 sata
        </h2>
        {skipped.length === 0 ? (
          <p className={EMPTY_BOX}>Nijedna odluka nije preskočena.</p>
        ) : (
          <TableScroll label="Preskočene odluke">
            <table className="w-full min-w-[32rem] text-sm">
              <thead>
                <tr>
                  <th className={TH}>Šifra</th>
                  <th className={TH}>Broj</th>
                  <th className={TH}>Šta znači</th>
                </tr>
              </thead>
              <tbody>
                {skipped.map((s) => (
                  <tr key={s.code ?? "none"} className={TR}>
                    <td className={`${TD} font-mono text-xs`}>{s.code ?? "—"}</td>
                    <td className={TD}>{s.n}</td>
                    <td className={TD}>{explainSkipCode(s.code)}</td>
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
