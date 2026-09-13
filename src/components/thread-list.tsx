import Link from "next/link";
import type { ThreadListItem } from "@/lib/queries/threads";
import { ThreadCard } from "./thread-card";

export function ThreadList({
  threads,
  showCommunity = true,
  emptyMessage = "Još nema tema.",
  nextHref,
}: {
  threads: ThreadListItem[];
  showCommunity?: boolean;
  emptyMessage?: string;
  nextHref?: string | null;
}) {
  if (threads.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-text-muted">
        {emptyMessage}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {threads.map((thread) => (
        <ThreadCard key={thread.id} thread={thread} showCommunity={showCommunity} />
      ))}
      {nextHref && (
        <nav aria-label="Straničenje" className="flex justify-center pt-2">
          <Link
            href={nextHref}
            className="rounded-md border border-border bg-surface px-4 py-2 text-sm text-text no-underline hover:bg-surface-muted"
          >
            Starije teme →
          </Link>
        </nav>
      )}
    </div>
  );
}
