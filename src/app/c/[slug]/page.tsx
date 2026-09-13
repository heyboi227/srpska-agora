import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/auto-refresh";
import { FeedTabs } from "@/components/feed-tabs";
import { ThreadList } from "@/components/thread-list";
import { getDb } from "@/lib/db/client";
import { getCommunitySummary } from "@/lib/queries/communities";
import { listFocusThreads, listThreads, type FeedSort } from "@/lib/queries/threads";
import { formatBelgradeDate } from "@/lib/time";
import { pluralSr } from "@/lib/utils";

export const dynamic = "force-dynamic";

const SORTS = new Set(["fokus", "novo", "aktivno", "najbolje"]);

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { slug } = await props.params;
  const community = await getCommunitySummary(getDb(), slug);
  return { title: community ? community.name : "Zajednica" };
}

export default async function CommunityPage(props: Props) {
  const [{ slug }, searchParams] = await Promise.all([props.params, props.searchParams]);
  const db = getDb();
  const community = await getCommunitySummary(db, slug);
  if (!community) notFound();

  const sortParam =
    typeof searchParams.sort === "string" && SORTS.has(searchParams.sort)
      ? searchParams.sort
      : "fokus";
  const cursor = typeof searchParams.cursor === "string" ? searchParams.cursor : null;
  const feed =
    sortParam === "fokus"
      ? {
          items: await listFocusThreads(db, { communityId: community.id, limit: 20 }),
          nextCursor: null,
        }
      : await listThreads(db, {
          sort: sortParam as FeedSort,
          communityId: community.id,
          cursor,
        });
  const nextHref = feed.nextCursor
    ? `/c/${community.slug}?sort=${sortParam}&cursor=${encodeURIComponent(feed.nextCursor)}`
    : null;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <AutoRefresh />
      <section className="flex flex-col gap-4">
        <header>
          <p className="text-xs uppercase tracking-wide text-text-muted">Zajednica</p>
          <h1 className="text-2xl font-semibold">{community.name}</h1>
          <p className="mt-1 max-w-3xl text-text-muted">{community.description}</p>
        </header>
        <FeedTabs current={sortParam} basePath={`/c/${community.slug}`} />
        <ThreadList
          threads={feed.items}
          showCommunity={false}
          nextHref={nextHref}
          emptyMessage="U ovoj zajednici još nema tema."
        />
      </section>
      <aside className="flex flex-col gap-4">
        <section className="rounded-lg border border-border bg-surface p-4 text-sm">
          <h2 className="font-semibold">Pravila zajednice</h2>
          <p className="mt-2 whitespace-pre-line text-text-muted">{community.rules}</p>
          <dl className="mt-3 grid grid-cols-2 gap-1 text-xs text-text-muted">
            <dt>Tema</dt>
            <dd>{pluralSr(community.threadCount, "tema", "teme", "tema")}</dd>
            <dt>Opis izmenjen</dt>
            <dd>{formatBelgradeDate(community.updatedAt)}</dd>
            <dt>Revizija opisa</dt>
            <dd>{community.revision}</dd>
          </dl>
        </section>
      </aside>
    </div>
  );
}
