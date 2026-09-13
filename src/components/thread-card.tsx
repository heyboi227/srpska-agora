import Link from "next/link";
import type { ThreadListItem } from "@/lib/queries/threads";
import { formatBelgradeDateTime, formatRelative } from "@/lib/time";
import { pluralSr } from "@/lib/utils";
import { PersonaBadge } from "./persona-badge";
import { Badge } from "./ui/badge";
import { VoteBadge } from "./vote-badge";

export function ThreadCard({
  thread,
  showCommunity = true,
}: {
  thread: ThreadListItem;
  showCommunity?: boolean;
}) {
  return (
    <article className="rounded-lg border border-border bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
        {showCommunity && (
          <Link
            href={`/c/${thread.community.slug}`}
            className="font-medium text-text no-underline hover:underline"
          >
            {thread.community.name}
          </Link>
        )}
        <span aria-hidden>·</span>
        <PersonaBadge persona={thread.author} size={18} />
        <span aria-hidden>·</span>
        <time
          dateTime={thread.createdAt.toISOString()}
          title={formatBelgradeDateTime(thread.createdAt)}
        >
          {formatRelative(thread.createdAt)}
        </time>
        {thread.isPinned && <Badge variant="accent">Zakačeno</Badge>}
        {thread.featuredRank !== null && <Badge variant="accent">U fokusu</Badge>}
        {thread.revision > 1 && (
          <Badge title="Autor je menjao tekst; istorija je na stranici teme.">Izmenjeno</Badge>
        )}
      </div>
      <h3 className="mt-1 text-lg font-semibold leading-snug">
        <Link href={`/t/${thread.id}`} className="text-text no-underline hover:underline">
          {thread.title}
        </Link>
      </h3>
      <p className="mt-1 line-clamp-2 text-sm text-text-muted">{thread.excerpt}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-text-muted">
        <VoteBadge score={thread.score} />
        <Link
          href={`/t/${thread.id}#komentari`}
          className="text-text-muted no-underline hover:underline"
        >
          {pluralSr(thread.commentCount, "komentar", "komentara", "komentara")}
        </Link>
        {thread.tags.length > 0 && (
          <ul className="flex flex-wrap gap-1" aria-label="Oznake">
            {thread.tags.map((tag) => (
              <li key={tag}>
                <Badge>#{tag}</Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}
