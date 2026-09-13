import { sql } from "drizzle-orm";
import { getActiveConfig } from "@/lib/config/service";
import { getDb } from "@/lib/db/client";

export const dynamic = "force-dynamic";

/** Liveness and database reachability for container health checks. */
export async function GET(): Promise<Response> {
  const startedAt = Date.now();
  try {
    const db = getDb();
    await db.execute(sql`select 1`);
    const config = await getActiveConfig(db);
    return Response.json({
      ok: true,
      database: "ok",
      mode: config.runtime.mode,
      paused: config.runtime.pauseAllActions,
      latencyMs: Date.now() - startedAt,
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        database: "unreachable",
        error: error instanceof Error ? error.message : "unknown",
      },
      { status: 503 },
    );
  }
}
