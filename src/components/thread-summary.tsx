import type { ThreadSummaryView } from "@/lib/queries/threads";
import { formatBelgradeDateTime, formatRelative } from "@/lib/time";
import { pluralSr } from "@/lib/utils";
import { CitationList } from "./citation-list";
import { ForumText } from "./forum-text";
import { Badge } from "./ui/badge";

/** Rolling AI summary of a thread, shown above the comments and labelled as machine-written. */
export function ThreadSummary({ summary }: { summary: ThreadSummaryView }) {
  return (
    <section
      aria-labelledby="sazetak-heading"
      className="rounded-lg border border-border bg-surface-muted p-4 sm:p-5"
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h2 id="sazetak-heading" className="text-lg font-semibold">
          Sažetak rasprave
        </h2>
        <Badge variant="ai">AI sažetak</Badge>
      </header>
      <p className="mt-1 text-sm text-text-muted">
        Obuhvata {pluralSr(summary.coversCommentCount, "komentar", "komentara", "komentara")} ·{" "}
        <time
          dateTime={summary.createdAt.toISOString()}
          title={formatBelgradeDateTime(summary.createdAt)}
        >
          {formatRelative(summary.createdAt)}
        </time>
      </p>
      <ForumText text={summary.body} className="mt-3" />
      <CitationList citations={summary.sources} />
    </section>
  );
}
