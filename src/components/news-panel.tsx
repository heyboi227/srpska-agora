import Link from "next/link";
import type { NewsItem, ResearchStatus } from "@/lib/queries/sources";
import { formatBelgradeDateTime, formatRelative } from "@/lib/time";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

/**
 * The current-news area. It never invents freshness: when no real source is
 * configured it says so, and fixture items are labelled as fixtures.
 */
export function NewsPanel({ items, status }: { items: NewsItem[]; status: ResearchStatus }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Vesti</CardTitle>
        <p className="text-xs text-text-muted">
          Poslednje uspešno istraživanje:{" "}
          {status.lastSuccessfulFetchAt ? (
            <time dateTime={status.lastSuccessfulFetchAt.toISOString()}>
              {formatBelgradeDateTime(status.lastSuccessfulFetchAt)}
            </time>
          ) : (
            <span>još nije pokrenuto</span>
          )}
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!status.configured && (
          <p className="rounded-md border border-warn/40 bg-surface-muted px-3 py-2 text-sm text-text">
            Izvori vesti nisu konfigurisani. Prikazani članci su demonstracioni podaci
            (fiksture), a ne stvarne vesti.
          </p>
        )}
        {items.length === 0 ? (
          <p className="text-sm text-text-muted">Nema članaka.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {items.map((item) => (
              <li key={item.id} className="text-sm">
                <div className="flex flex-wrap items-center gap-1 text-xs text-text-muted">
                  <span className="font-medium text-text">{item.publisher}</span>
                  {item.isFixture && <Badge variant="warn">fikstura</Badge>}
                  <span aria-hidden>·</span>
                  <time
                    dateTime={item.publishedAt.toISOString()}
                    title={`Objavljeno ${formatBelgradeDateTime(item.publishedAt)}`}
                  >
                    {formatRelative(item.publishedAt)}
                  </time>
                </div>
                <a
                  href={item.canonicalUrl}
                  rel="noopener noreferrer nofollow"
                  target="_blank"
                  className="font-medium"
                >
                  {item.title}
                </a>
                <p className="mt-0.5 line-clamp-3 text-text-muted">{item.summary}</p>
              </li>
            ))}
          </ul>
        )}
        <Link href="/izvori" className="text-sm">
          Odakle dolaze vesti →
        </Link>
      </CardContent>
    </Card>
  );
}
