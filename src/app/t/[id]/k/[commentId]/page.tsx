import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CommentTree } from "@/components/comment-tree";
import { getDb } from "@/lib/db/client";
import { loadCommentSubtree } from "@/lib/queries/comments";
import { getThreadDetail } from "@/lib/queries/threads";
import { isAdminViewer } from "@/server/auth";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Nastavak diskusije" };

type Props = { params: Promise<{ id: string; commentId: string }> };

/** Continuation view: one comment and everything beneath it. */
export default async function CommentSubtreePage(props: Props) {
  const { id, commentId } = await props.params;
  const db = getDb();
  const thread = await getThreadDetail(db, id);
  if (!thread || thread.status === "quarantined") notFound();
  const subtree = await loadCommentSubtree(db, thread.id, commentId);
  if (!subtree) notFound();
  const isAdmin = await isAdminViewer();
  const anchor = { ...subtree.anchor, children: subtree.tree, hasMoreBelow: false };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <nav aria-label="Putanja" className="text-sm text-text-muted">
        <Link href={`/c/${thread.community.slug}`}>{thread.community.name}</Link>{" "}
        <span aria-hidden>›</span> <Link href={`/t/${thread.id}`}>{thread.title}</Link>
      </nav>
      <h1 className="text-lg font-semibold">Nastavak diskusije</h1>
      {anchor.parentCommentId && (
        <p className="text-sm">
          <Link href={`/t/${thread.id}/k/${anchor.parentCommentId}`}>← Nadređeni komentar</Link>
        </p>
      )}
      <CommentTree nodes={[anchor]} threadId={thread.id} isAdmin={isAdmin} />
    </div>
  );
}
