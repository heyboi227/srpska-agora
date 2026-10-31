import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ModerationControls } from "@/components/admin/moderation-controls";
import { AutoRefresh } from "@/components/auto-refresh";
import { CitationList } from "@/components/citation-list";
import { CommentTree } from "@/components/comment-tree";
import { ForumText } from "@/components/forum-text";
import { PersonaBadge } from "@/components/persona-badge";
import { ThreadSummary } from "@/components/thread-summary";
import { Badge } from "@/components/ui/badge";
import { VoteBadge } from "@/components/vote-badge";
import { getDb } from "@/lib/db/client";
import { latestModerationDecision } from "@/lib/domain/moderation";
import { listRevisions } from "@/lib/domain/revisions";
import { loadCommentTree } from "@/lib/queries/comments";
import { getLatestThreadSummary, getThreadDetail } from "@/lib/queries/threads";
import { formatBelgradeDateTime, formatRelative } from "@/lib/time";
import { pluralSr } from "@/lib/utils";
import { isAdminViewer } from "@/server/auth";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { id } = await props.params;
  const thread = await getThreadDetail(getDb(), id);
  return { title: thread && thread.status === "published" ? thread.title : "Tema" };
}

export default async function ThreadPage(props: Props) {
  const { id } = await props.params;
  const db = getDb();
  const thread = await getThreadDetail(db, id);
  if (!thread || thread.status === "quarantined") notFound();
  const isAdmin = await isAdminViewer();
  const [tree, revisions, decision, summary] = await Promise.all([
    loadCommentTree(db, thread.id),
    listRevisions(db, "thread", thread.id),
    thread.status === "hidden"
      ? latestModerationDecision(db, "thread", thread.id)
      : Promise.resolve(null),
    thread.status === "published"
      ? getLatestThreadSummary(db, thread.id)
      : Promise.resolve(null),
  ]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <AutoRefresh />
      <nav aria-label="Putanja" className="text-sm text-text-muted">
        <Link href="/">Početna</Link> <span aria-hidden>›</span>{" "}
        <Link href={`/c/${thread.community.slug}`}>{thread.community.name}</Link>
      </nav>

      <article className="rounded-lg border border-border bg-surface p-5">
        <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-muted">
          <PersonaBadge persona={thread.author} />
          <span aria-hidden>·</span>
          <time
            dateTime={thread.createdAt.toISOString()}
            title={formatBelgradeDateTime(thread.createdAt)}
          >
            {formatRelative(thread.createdAt)}
          </time>
          {thread.isPinned && <Badge variant="accent">Zakačeno</Badge>}
          {thread.featuredRank !== null && <Badge variant="accent">U fokusu</Badge>}
          <Badge title="Pismo u kom je tema napisana">
            {thread.script === "Cyrillic" ? "ћирилица" : "latinica"}
          </Badge>
        </header>
        <h1 className="mt-2 text-2xl font-semibold leading-tight">{thread.title}</h1>

        {thread.status === "hidden" ? (
          <p className="mt-4 rounded-md border border-dashed border-border bg-surface-muted px-3 py-2 text-sm text-text-muted">
            Temu je sakrila moderacija.
            {decision?.explanation && (
              <span className="block">Obrazloženje: {decision.explanation}</span>
            )}
          </p>
        ) : (
          <>
            <ForumText text={thread.body} className="mt-4" />
            <CitationList
              citations={thread.citations.map((cite) => ({
                claimExcerpt: cite.claimExcerpt,
                title: cite.article.title,
                canonicalUrl: cite.article.canonicalUrl,
                publisher: cite.article.publisher,
                isFixture: cite.article.isFixture,
                publishedAt: cite.article.publishedAt,
              }))}
            />
          </>
        )}

        <footer className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-text-muted">
          <VoteBadge score={thread.score} />
          <span>{pluralSr(thread.commentCount, "komentar", "komentara", "komentara")}</span>
          {thread.tags.length > 0 && (
            <ul className="flex flex-wrap gap-1" aria-label="Oznake">
              {thread.tags.map((tag) => (
                <li key={tag}>
                  <Badge>#{tag}</Badge>
                </li>
              ))}
            </ul>
          )}
          {isAdmin && (
            <ModerationControls
              targetType="thread"
              targetId={thread.id}
              threadId={thread.id}
              status={thread.status}
            />
          )}
        </footer>

        {revisions.length > 1 && (
          <details className="mt-4 rounded-md border border-border bg-surface-muted p-3 text-sm">
            <summary className="font-medium">Istorija izmena ({revisions.length})</summary>
            <ol className="mt-2 flex flex-col gap-3">
              {revisions.map((revision) => (
                <li
                  key={revision.id}
                  className="border-t border-border pt-2 first:border-t-0 first:pt-0"
                >
                  <p className="text-xs text-text-muted">
                    Revizija {revision.revision} · {formatBelgradeDateTime(revision.createdAt)}
                    {revision.reason && <span> · Razlog: {revision.reason}</span>}
                  </p>
                  <details className="mt-1">
                    <summary className="text-xs">Prikaži tekst ove revizije</summary>
                    {revision.title && <p className="mt-1 font-medium">{revision.title}</p>}
                    <ForumText text={revision.body} className="mt-1 text-sm" />
                  </details>
                </li>
              ))}
            </ol>
          </details>
        )}
      </article>

      {summary && <ThreadSummary summary={summary} />}

      <section
        id="komentari"
        aria-labelledby="komentari-heading"
        className="flex flex-col gap-3"
      >
        <h2 id="komentari-heading" className="text-lg font-semibold">
          Komentari{" "}
          <span className="text-sm font-normal text-text-muted">({thread.commentCount})</span>
        </h2>
        {tree.roots.length === 0 ? (
          <p className="text-sm text-text-muted">Još nema komentara.</p>
        ) : (
          <CommentTree nodes={tree.roots} threadId={thread.id} isAdmin={isAdmin} />
        )}
        {tree.hasMoreRoots && (
          <p className="text-sm text-text-muted">
            Prikazan je prvi deo diskusije ({tree.loaded} komentara). Straničenje korena stiže
            uz pretragu u fazi 4.
          </p>
        )}
      </section>
    </div>
  );
}
