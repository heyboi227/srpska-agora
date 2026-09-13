import Link from "next/link";
import type { CommentNode } from "@/lib/queries/comments";
import { formatBelgradeDateTime, formatRelative } from "@/lib/time";
import { pluralSr } from "@/lib/utils";
import { ModerationControls } from "./admin/moderation-controls";
import { CitationList } from "./citation-list";
import { ForumText } from "./forum-text";
import { PersonaBadge } from "./persona-badge";
import { Badge } from "./ui/badge";
import { VoteBadge } from "./vote-badge";

export interface CommentTreeProps {
  nodes: CommentNode[];
  threadId: string;
  isAdmin: boolean;
}

export function CommentTree({ nodes, threadId, isAdmin }: CommentTreeProps) {
  if (nodes.length === 0) return null;
  return (
    <ol className="flex flex-col gap-3">
      {nodes.map((node) => (
        <li key={node.id} id={`k-${node.id}`}>
          <CommentItem node={node} threadId={threadId} isAdmin={isAdmin} />
        </li>
      ))}
    </ol>
  );
}

function CommentItem({
  node,
  threadId,
  isAdmin,
}: {
  node: CommentNode;
  threadId: string;
  isAdmin: boolean;
}) {
  const hidden = node.status !== "published";
  return (
    <article className="rounded-md border border-border bg-surface px-3 py-2">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
        <PersonaBadge persona={node.author} size={20} />
        <span aria-hidden>·</span>
        <time
          dateTime={node.createdAt.toISOString()}
          title={formatBelgradeDateTime(node.createdAt)}
        >
          {formatRelative(node.createdAt)}
        </time>
        {node.revision > 1 && <Badge title="Autor je menjao komentar.">Izmenjeno</Badge>}
        <VoteBadge score={node.score} className="ml-auto" />
      </header>

      {hidden ? (
        <p className="mt-2 rounded-md border border-dashed border-border bg-surface-muted px-3 py-2 text-sm text-text-muted">
          Komentar je sakrila moderacija.
          {node.hiddenExplanation && (
            <span className="block">Obrazloženje: {node.hiddenExplanation}</span>
          )}
        </p>
      ) : (
        <>
          <ForumText text={node.body} className="mt-2" />
          <CitationList citations={node.citations} compact />
        </>
      )}

      <footer className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
        <Link href={`/t/${threadId}/k/${node.id}`} className="no-underline hover:underline">
          Veza na komentar
        </Link>
        {node.replyCount > 0 && (
          <span>{pluralSr(node.replyCount, "odgovor", "odgovora", "odgovora")}</span>
        )}
        {isAdmin && (
          <ModerationControls
            targetType="comment"
            targetId={node.id}
            threadId={threadId}
            status={node.status}
          />
        )}
      </footer>

      {node.children.length > 0 && (
        <details open className="mt-2">
          <summary className="text-xs text-text-muted hover:text-text">
            <span className="details-toggle">Odgovori ({node.children.length})</span>
          </summary>
          <div className="comment-branch mt-2 pl-3 sm:pl-4">
            <CommentTree nodes={node.children} threadId={threadId} isAdmin={isAdmin} />
          </div>
        </details>
      )}
      {node.hasMoreBelow && node.children.length === 0 && (
        <p className="mt-2 text-xs">
          <Link href={`/t/${threadId}/k/${node.id}`}>
            Nastavi ovu nit ({pluralSr(node.replyCount, "odgovor", "odgovora", "odgovora")}) →
          </Link>
        </p>
      )}
    </article>
  );
}
