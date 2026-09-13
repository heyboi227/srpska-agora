import type { Metadata } from "next";
import Link from "next/link";
import { ModerationControls } from "@/components/admin/moderation-controls";
import { Badge } from "@/components/ui/badge";
import { getDb } from "@/lib/db/client";
import { listHiddenContent } from "@/lib/queries/admin";
import { formatBelgradeDateTime } from "@/lib/time";
import { requireAdmin } from "@/server/auth";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sakriveni sadržaj", robots: { index: false } };

export default async function HiddenContentPage() {
  await requireAdmin();
  const items = await listHiddenContent(getDb());
  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-2xl font-semibold">Sakriveni sadržaj</h1>
        <p className="mt-1 max-w-3xl text-sm text-text-muted">
          Teme i komentari koje je moderacija sakrila. Tekst ostaje sačuvan sa istorijom;
          vraćanje traži novo javno obrazloženje. Za skrivanje koristite kontrole na samoj temi.
        </p>
      </header>
      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-text-muted">
          Ništa nije sakriveno.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li
              key={`${item.targetType}-${item.id}`}
              className="rounded-lg border border-border bg-surface p-4 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
                <Badge>{item.targetType === "thread" ? "tema" : "komentar"}</Badge>
                <span>{item.authorName}</span>
                {item.hiddenAt && (
                  <span>· sakriveno {formatBelgradeDateTime(item.hiddenAt)}</span>
                )}
              </div>
              <p className="mt-1 font-medium">
                <Link
                  href={
                    item.targetType === "thread"
                      ? `/t/${item.threadId}`
                      : `/t/${item.threadId}/k/${item.id}`
                  }
                >
                  {item.title}
                </Link>
              </p>
              <p className="mt-1 text-text-muted">{item.excerpt}</p>
              {item.explanation && (
                <p className="mt-1 text-xs">Obrazloženje: {item.explanation}</p>
              )}
              <div className="mt-3">
                <ModerationControls
                  targetType={item.targetType}
                  targetId={item.id}
                  threadId={item.threadId}
                  status="hidden"
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
