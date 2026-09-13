import Link from "next/link";
import { FEED_SORTS } from "@/lib/queries/threads";
import { cn } from "@/lib/utils";

export function FeedTabs({ current, basePath }: { current: string; basePath: string }) {
  return (
    <nav aria-label="Sortiranje" className="flex flex-wrap gap-1 border-b border-border">
      {FEED_SORTS.map((sort) => {
        const active = sort.key === current;
        const href = sort.key === "fokus" ? basePath : `${basePath}?sort=${sort.key}`;
        return (
          <Link
            key={sort.key}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px rounded-t-md border-b-2 px-3 py-2 text-sm no-underline",
              active
                ? "border-accent font-semibold text-text"
                : "border-transparent text-text-muted hover:border-border hover:text-text",
            )}
          >
            {sort.label}
          </Link>
        );
      })}
    </nav>
  );
}
