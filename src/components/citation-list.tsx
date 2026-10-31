import { formatBelgradeDate } from "@/lib/time";
import { Badge } from "./ui/badge";

export interface CitationView {
  claimExcerpt: string;
  title: string;
  canonicalUrl: string;
  publisher: string;
  isFixture: boolean;
  publishedAt?: Date;
}

/** Sources cited by a contribution: publisher, title, link, and the claim they support. */
export function CitationList({
  citations,
  compact = false,
}: {
  citations: CitationView[];
  compact?: boolean;
}) {
  if (citations.length === 0) return null;
  return (
    <section
      aria-label="Izvori"
      className={
        compact
          ? "mt-2 text-xs"
          : "mt-4 rounded-md border border-border bg-surface-muted p-3 text-sm"
      }
    >
      {!compact && <h4 className="mb-2 font-semibold">Izvori</h4>}
      <ol className="flex flex-col gap-1.5">
        {citations.map((cite, index) => (
          <li
            key={`${cite.canonicalUrl}-${index}`}
            className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
          >
            <span className="font-medium">{cite.publisher}</span>
            {cite.isFixture && <Badge variant="warn">fikstura</Badge>}
            <a href={cite.canonicalUrl} rel="noopener noreferrer nofollow" target="_blank">
              {cite.title}
            </a>
            {cite.publishedAt && (
              <span className="text-text-muted">({formatBelgradeDate(cite.publishedAt)})</span>
            )}
            {cite.claimExcerpt && (
              <span className="w-full text-text-muted">Podržava: „{cite.claimExcerpt}“</span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
