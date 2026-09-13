import { AutoRefresh } from "@/components/auto-refresh";
import { FeedTabs } from "@/components/feed-tabs";
import { NewsPanel } from "@/components/news-panel";
import { DISCLOSURE } from "@/components/site-footer";
import { ThreadList } from "@/components/thread-list";
import { getDb } from "@/lib/db/client";
import { getResearchStatus, listLatestArticles } from "@/lib/queries/sources";
import { listFocusThreads, listThreads, type FeedSort } from "@/lib/queries/threads";

export const dynamic = "force-dynamic";

const SORTS = new Set(["fokus", "novo", "aktivno", "najbolje"]);

export default async function HomePage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const searchParams = await props.searchParams;
  const sortParam =
    typeof searchParams.sort === "string" && SORTS.has(searchParams.sort)
      ? searchParams.sort
      : "fokus";
  const cursor = typeof searchParams.cursor === "string" ? searchParams.cursor : null;
  const db = getDb();

  const [feed, news, status] = await Promise.all([
    sortParam === "fokus"
      ? listFocusThreads(db).then((items) => ({ items, nextCursor: null }))
      : listThreads(db, { sort: sortParam as FeedSort, cursor }),
    listLatestArticles(db, 5),
    getResearchStatus(db),
  ]);

  const nextHref = feed.nextCursor
    ? `/?sort=${sortParam}&cursor=${encodeURIComponent(feed.nextCursor)}`
    : null;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <AutoRefresh />
      <section aria-labelledby="feed-heading" className="flex flex-col gap-4">
        <div className="rounded-lg border border-ai/30 bg-ai-soft px-4 py-3 text-sm text-text">
          {DISCLOSURE}
        </div>
        <h1 id="feed-heading" className="sr-only">
          Diskusije
        </h1>
        <FeedTabs current={sortParam} basePath="/" />
        <ThreadList
          threads={feed.items}
          nextHref={nextHref}
          emptyMessage="Još nema tema. Pokrenite seed ili sačekajte sagovornike."
        />
      </section>
      <aside className="flex flex-col gap-4">
        <NewsPanel items={news} status={status} />
      </aside>
    </div>
  );
}
