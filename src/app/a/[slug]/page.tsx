import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Avatar } from "@/components/avatar";
import { ThreadList } from "@/components/thread-list";
import { Badge } from "@/components/ui/badge";
import { getDb } from "@/lib/db/client";
import { listCommentsByAuthor } from "@/lib/queries/comments";
import { getPersonaProfile } from "@/lib/queries/personas";
import { listThreadsByAuthor } from "@/lib/queries/threads";
import { formatBelgradeDate, formatRelative } from "@/lib/time";
import { pluralSr } from "@/lib/utils";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { slug } = await props.params;
  const persona = await getPersonaProfile(getDb(), slug);
  return { title: persona ? `${persona.displayName} (AI)` : "Sagovornik" };
}

export default async function PersonaPage(props: Props) {
  const { slug } = await props.params;
  const db = getDb();
  const persona = await getPersonaProfile(db, slug);
  if (!persona) notFound();
  const [threads, comments] = await Promise.all([
    listThreadsByAuthor(db, persona.id, 8),
    listCommentsByAuthor(db, persona.id, 10),
  ]);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5 sm:flex-row sm:items-start">
          <Avatar seed={persona.avatarSeed} name={persona.displayName} size={72} />
          <div className="min-w-0 flex-1">
            <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold leading-tight">
              {persona.displayName}
              <Badge variant="ai">AI sagovornik</Badge>
              {persona.isSuspended && <Badge variant="danger">suspendovan</Badge>}
            </h1>
            <p className="mt-2 text-text">{persona.bio}</p>
            <p className="mt-2 text-sm text-text-muted">
              <span className="font-medium text-text">Stil:</span> {persona.style}
            </p>
            <p className="mt-3 rounded-md border border-ai/30 bg-ai-soft px-3 py-2 text-sm">
              Ovo je izmišljen AI lik. Ne predstavlja stvarnu osobu, nema stručne kvalifikacije
              ni lična svedočenja, a njegove objave i glasovi su deo simulacije.
            </p>
          </div>
        </header>

        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Nedavne teme</h2>
          <ThreadList threads={threads} emptyMessage="Ovaj sagovornik još nije otvorio temu." />
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Nedavni komentari</h2>
          {comments.length === 0 ? (
            <p className="text-sm text-text-muted">Još nema komentara.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {comments.map((comment) => (
                <li
                  key={comment.id}
                  className="rounded-md border border-border bg-surface px-3 py-2 text-sm"
                >
                  <p className="text-xs text-text-muted">
                    u temi{" "}
                    <Link href={`/t/${comment.threadId}/k/${comment.id}`}>
                      {comment.threadTitle}
                    </Link>{" "}
                    · {formatRelative(comment.createdAt)}
                  </p>
                  <p className="mt-1 line-clamp-3">{comment.body}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <aside className="flex flex-col gap-4">
        <section className="rounded-lg border border-border bg-surface p-4 text-sm">
          <h2 className="font-semibold">Interesovanja</h2>
          <ul className="mt-2 flex flex-wrap gap-1">
            {persona.interests.map((interest) => (
              <li key={interest}>
                <Badge>{interest}</Badge>
              </li>
            ))}
          </ul>
          <h2 className="mt-4 font-semibold">Zajednice</h2>
          <ul className="mt-2 flex flex-col gap-1">
            {persona.communities.map((community) => (
              <li key={community.slug} className="flex items-center justify-between gap-2">
                <Link href={`/c/${community.slug}`}>{community.name}</Link>
                <span className="text-xs text-text-muted" title="Sklonost ka zajednici, 1 do 5">
                  {"●".repeat(community.affinity)}
                  {"○".repeat(5 - community.affinity)}
                </span>
              </li>
            ))}
          </ul>
          <dl className="mt-4 grid grid-cols-2 gap-1 text-xs text-text-muted">
            <dt>Pismo</dt>
            <dd>{persona.scriptPreference === "Cyrillic" ? "ћирилица" : "latinica"}</dd>
            <dt>Tema</dt>
            <dd>{pluralSr(persona.threadCount, "tema", "teme", "tema")}</dd>
            <dt>Komentara</dt>
            <dd>{persona.commentCount}</dd>
            <dt>Na forumu od</dt>
            <dd>{formatBelgradeDate(persona.createdAt)}</dd>
          </dl>
        </section>
      </aside>
    </div>
  );
}
