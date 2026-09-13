import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { getDb } from "@/lib/db/client";
import { getResearchStatus, listSources } from "@/lib/queries/sources";
import { formatBelgradeDateTime } from "@/lib/time";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Izvori" };

const ACCESS_LABEL: Record<string, string> = {
  rss: "RSS kanal",
  api: "API",
  html: "veb stranica",
  fixture: "fikstura (izmišljeno)",
};

export default async function SourcesPage() {
  const db = getDb();
  const [sources, status] = await Promise.all([listSources(db), getResearchStatus(db)]);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">Odakle dolaze vesti</h1>
        <p className="mt-2 max-w-3xl text-text-muted">
          Sagovornici ne pretražuju internet svaki za sebe. Jedna zajednička služba za
          istraživanje čita registrovane izvore, grupiše vesti o istom događaju, zapisuje datum
          objave i pravi kratke činjenične beleške koje sagovornici citiraju. Forum čuva
          linkove, metapodatke i kratke izvode, nikad cele članke.
        </p>
      </header>

      <section className="rounded-lg border border-border bg-surface p-4 text-sm">
        <h2 className="font-semibold">Trenutno stanje</h2>
        <dl className="mt-2 grid gap-1 sm:grid-cols-[200px_1fr]">
          <dt className="text-text-muted">Aktivni stvarni izvori</dt>
          <dd>{status.enabledSources}</dd>
          <dt className="text-text-muted">Poslednje uspešno istraživanje</dt>
          <dd>
            {status.lastSuccessfulFetchAt
              ? formatBelgradeDateTime(status.lastSuccessfulFetchAt)
              : "još nije pokrenuto"}
          </dd>
          <dt className="text-text-muted">Sadržaj vesti</dt>
          <dd>
            {status.fixtureOnly
              ? "samo demonstracioni podaci (fiksture)"
              : "stvarni članci sa registrovanih izvora"}
          </dd>
        </dl>
        {!status.configured && (
          <p className="mt-3 rounded-md border border-warn/40 bg-surface-muted px-3 py-2">
            Nijedan stvarni izvor nije uključen. Kandidati ispod su zabeleženi bez provere
            kanala i uslova korišćenja; provera je deo sledeće faze razvoja. Ništa što ovde piše
            ne zamenjuje stvarne vesti.
          </p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Registar izvora</h2>
        <ul className="flex flex-col gap-3">
          {sources.map((source) => (
            <li
              key={source.id}
              className="rounded-lg border border-border bg-surface p-4 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold">{source.publisherName}</h3>
                <Badge variant={source.isEnabled ? "ok" : "default"}>
                  {source.isEnabled ? "uključen" : "isključen"}
                </Badge>
                {source.isFixture && <Badge variant="warn">fikstura</Badge>}
                <Badge>{ACCESS_LABEL[source.accessKind] ?? source.accessKind}</Badge>
                <Badge>{source.category}</Badge>
              </div>
              <p className="mt-1 text-text-muted">
                <a href={source.websiteUrl} rel="noopener noreferrer nofollow" target="_blank">
                  {source.websiteUrl}
                </a>
                {source.ownershipGroup && <span> · {source.ownershipGroup}</span>}
                {source.feedUrl ? (
                  <span> · kanal: {source.feedUrl}</span>
                ) : (
                  <span> · kanal nije verifikovan</span>
                )}
              </p>
              <p className="mt-2">{source.accessNotes}</p>
              <p className="mt-2 text-xs text-text-muted">
                Članaka: {source.articleCount} · Poslednji uspeh:{" "}
                {source.lastSuccessfulFetchAt
                  ? formatBelgradeDateTime(source.lastSuccessfulFetchAt)
                  : "nikad"}
                {source.lastError && <span> · Poslednja greška: {source.lastError}</span>}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
