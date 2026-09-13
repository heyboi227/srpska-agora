import type { Metadata } from "next";
import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { searchForum } from "@/lib/queries/search";
import { formatRelative } from "@/lib/time";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Pretraga" };

export default async function SearchPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const searchParams = await props.searchParams;
  const q = typeof searchParams.q === "string" ? searchParams.q : "";
  const results = q.trim().length > 0 ? await searchForum(getDb(), q) : null;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <h1 className="text-2xl font-semibold">Pretraga</h1>
      <form action="/pretraga" method="get" role="search" className="flex gap-2">
        <label htmlFor="q" className="sr-only">
          Upit
        </label>
        <input
          id="q"
          name="q"
          type="search"
          defaultValue={q}
          placeholder="npr. ajvar, Нови Сад, gradski prevoz"
          className="h-10 flex-1 rounded-md border border-border bg-surface px-3 text-text"
        />
        <button
          type="submit"
          className="h-10 rounded-md border border-accent bg-accent px-4 text-sm font-medium text-white"
        >
          Traži
        </button>
      </form>
      <p className="text-sm text-text-muted">
        Pretraga radi jednako za ćirilicu i latinicu, sa ili bez dijakritika: „Ђорђе“, „Đorđe“ i
        „Djordje“ daju iste rezultate.
      </p>

      {results && results.tooShort && (
        <p className="text-text-muted">Upit je prekratak. Unesite bar dva slova.</p>
      )}

      {results && !results.tooShort && (
        <div className="flex flex-col gap-6">
          <section>
            <h2 className="text-lg font-semibold">Zajednice ({results.communities.length})</h2>
            {results.communities.length === 0 ? (
              <p className="text-sm text-text-muted">Nema poklapanja.</p>
            ) : (
              <ul className="mt-2 flex flex-col gap-1">
                {results.communities.map((community) => (
                  <li key={community.slug}>
                    <Link href={`/c/${community.slug}`}>{community.name}</Link>
                    <span className="text-sm text-text-muted"> · {community.description}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h2 className="text-lg font-semibold">Teme ({results.threads.length})</h2>
            {results.threads.length === 0 ? (
              <p className="text-sm text-text-muted">Nema poklapanja.</p>
            ) : (
              <ul className="mt-2 flex flex-col gap-2">
                {results.threads.map((thread) => (
                  <li
                    key={thread.id}
                    className="rounded-md border border-border bg-surface px-3 py-2"
                  >
                    <p className="text-xs text-text-muted">
                      {thread.communityName} · {thread.authorName} ·{" "}
                      {formatRelative(thread.createdAt)}
                    </p>
                    <Link href={`/t/${thread.id}`} className="font-medium">
                      {thread.title}
                    </Link>
                    <p className="mt-1 line-clamp-2 text-sm text-text-muted">
                      {thread.excerpt}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h2 className="text-lg font-semibold">Komentari ({results.comments.length})</h2>
            {results.comments.length === 0 ? (
              <p className="text-sm text-text-muted">Nema poklapanja.</p>
            ) : (
              <ul className="mt-2 flex flex-col gap-2">
                {results.comments.map((comment) => (
                  <li
                    key={comment.id}
                    className="rounded-md border border-border bg-surface px-3 py-2 text-sm"
                  >
                    <p className="text-xs text-text-muted">
                      {comment.authorName} u temi{" "}
                      <Link href={`/t/${comment.threadId}/k/${comment.id}`}>
                        {comment.threadTitle}
                      </Link>{" "}
                      · {formatRelative(comment.createdAt)}
                    </p>
                    <p className="mt-1 line-clamp-3">{comment.excerpt}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
