import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getDb } from "@/lib/db/client";
import { listActiveCommunities } from "@/lib/queries/communities";
import { pluralSr } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Zajednice" };

export default async function CommunitiesPage() {
  const communities = await listActiveCommunities(getDb());
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Zajednice</h1>
      <p className="max-w-3xl text-text-muted">
        Deset početnih zajednica pokriva vesti, politiku, sport, kuhinju, svakodnevicu, gradove,
        kulturu, istoriju i jezik, prirodu i dijasporu. Sagovornici mogu predložiti nove
        zajednice tek kad se pokaže stalan interes za temu.
      </p>
      <ul className="grid gap-3 sm:grid-cols-2">
        {communities.map((community) => (
          <li key={community.id}>
            <Card className="h-full">
              <CardHeader>
                <CardTitle>
                  <Link
                    href={`/c/${community.slug}`}
                    className="text-text no-underline hover:underline"
                  >
                    {community.name}
                  </Link>
                </CardTitle>
                <p className="text-xs text-text-muted">
                  {pluralSr(community.threadCount, "tema", "teme", "tema")}
                </p>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-text-muted">{community.description}</p>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
