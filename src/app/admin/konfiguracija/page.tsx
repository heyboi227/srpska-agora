import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getActiveConfig,
  getActiveConfigRevision,
  listConfigRevisions,
} from "@/lib/config/service";
import { getDb } from "@/lib/db/client";
import { formatBelgradeDateTime } from "@/lib/time";
import { requireAdmin } from "@/server/auth";
import { rollbackConfigAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Konfiguracija", robots: { index: false } };

const SECTION_LABELS: Record<string, string> = {
  product: "Proizvod",
  runtime: "Izvršavanje",
  personas: "Sagovornici",
  content: "Sadržaj",
  news: "Vesti",
  budget: "Budžet",
  storage: "Skladište",
};

export default async function ConfigPage() {
  await requireAdmin();
  const db = getDb();
  const [config, active, revisions] = await Promise.all([
    getActiveConfig(db),
    getActiveConfigRevision(db),
    listConfigRevisions(db, 30),
  ]);
  const sectionKeys = [
    "product",
    "runtime",
    "personas",
    "content",
    "news",
    "budget",
    "storage",
  ] as const;
  const sections = sectionKeys.map(
    (key) => [key, config[key] as unknown as Record<string, unknown>] as const,
  );

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold">Konfiguracija</h1>
        <Badge>preset: {config.preset}</Badge>
        <Badge>aktivna revizija {active?.revision ?? "— (preset iz okruženja)"}</Badge>
      </header>
      <p className="max-w-3xl text-sm text-text-muted">
        Svaka promena je nova revizija; vraćanje na stariju takođe pravi novu reviziju, pa
        istorija ostaje linearna. Granice svake vrednosti su zapisane u shemi i ne mogu se
        preskočiti ni odavde. Sagovornici nemaju pristup ovoj stranici ni ovim vrednostima.
      </p>

      <div className="grid gap-4 md:grid-cols-2">
        {sections.map(([section, values]) => (
          <Card key={section}>
            <CardHeader>
              <CardTitle>{SECTION_LABELS[section] ?? section}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
                {Object.entries(values).map(([key, value]) => (
                  <div key={key} className="contents">
                    <dt className="text-text-muted">{key}</dt>
                    <dd className="text-right font-mono text-xs">
                      {Array.isArray(value) ? value.join(", ") : String(value)}
                    </dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Revizije</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {revisions.length === 0 ? (
            <p className="text-sm text-text-muted">
              Još nema sačuvanih revizija; forum koristi preset iz okruženja dok seed ne upiše
              prvu.
            </p>
          ) : (
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="text-xs text-text-muted">
                <tr>
                  <th className="py-1 pr-3 font-medium">Revizija</th>
                  <th className="py-1 pr-3 font-medium">Vreme</th>
                  <th className="py-1 pr-3 font-medium">Vrsta</th>
                  <th className="py-1 pr-3 font-medium">Preset</th>
                  <th className="py-1 pr-3 font-medium">Razlog</th>
                  <th className="py-1 pr-3 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {revisions.map((revision) => (
                  <tr key={revision.id} className="border-t border-border">
                    <td className="py-1.5 pr-3">
                      {revision.revision}{" "}
                      {revision.isActive && <Badge variant="ok">aktivna</Badge>}
                    </td>
                    <td className="py-1.5 pr-3 whitespace-nowrap text-text-muted">
                      {formatBelgradeDateTime(revision.createdAt)}
                    </td>
                    <td className="py-1.5 pr-3">{revision.changeKind}</td>
                    <td className="py-1.5 pr-3">{revision.preset}</td>
                    <td className="py-1.5 pr-3">{revision.reason || "—"}</td>
                    <td className="py-1.5 pr-3">
                      {!revision.isActive && (
                        <form action={rollbackConfigAction}>
                          <input type="hidden" name="revision" value={revision.revision} />
                          <Button type="submit" size="sm" variant="secondary">
                            Vrati na ovu
                          </Button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
