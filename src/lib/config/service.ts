import { desc, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import { configRevisions } from "@/lib/db/schema";
import { getEnv } from "@/lib/env";
import { getPreset } from "./presets";
import { parseConfig, type AgoraConfig } from "./schema";

/**
 * Configuration lives in the database as an append-only list of revisions with
 * exactly one active. Reads are cached for a few seconds per process; the
 * scheduler and every request therefore see a change within one tick.
 */

const CACHE_TTL_MS = 5_000;
const CONFIG_LOCK_KEY = 727_001;

interface CacheEntry {
  value: AgoraConfig;
  revision: number | null;
  loadedAt: number;
}

let cache: CacheEntry | undefined;

export function invalidateConfigCache(): void {
  cache = undefined;
}

export interface ConfigRevisionSummary {
  id: string;
  revision: number;
  changeKind: "seed" | "admin" | "curator" | "system";
  reason: string;
  isActive: boolean;
  createdAt: Date;
  preset: string;
}

export async function getActiveConfigRevision(
  db: DbOrTx,
): Promise<{ revision: number; config: AgoraConfig; createdAt: Date } | null> {
  const rows = await db
    .select()
    .from(configRevisions)
    .where(eq(configRevisions.isActive, true))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { revision: row.revision, config: parseConfig(row.config), createdAt: row.createdAt };
}

/**
 * The active configuration, or the environment's preset when the table is
 * still empty (before the first seed). The fallback is deliberate: a fresh
 * checkout must render, and the preset is the same object the seed will store.
 */
export async function getActiveConfig(db: DbOrTx): Promise<AgoraConfig> {
  const now = Date.now();
  if (cache && now - cache.loadedAt < CACHE_TTL_MS) return cache.value;
  const active = await getActiveConfigRevision(db);
  const value = active ? active.config : getPreset(getEnv().AGORA_CONFIG_PRESET);
  cache = { value, revision: active?.revision ?? null, loadedAt: now };
  return value;
}

export interface SaveConfigParams {
  config: AgoraConfig;
  changeKind: "seed" | "admin" | "curator" | "system";
  changedByAccountId: string | null;
  reason: string;
}

/** Validates, deactivates the current revision, and inserts the new active one. */
export async function saveConfigRevision(
  db: DbOrTx,
  params: SaveConfigParams,
): Promise<{ revision: number; id: string }> {
  const config = parseConfig(params.config);
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${CONFIG_LOCK_KEY})`);
    await tx
      .update(configRevisions)
      .set({ isActive: false })
      .where(eq(configRevisions.isActive, true));
    const [{ next }] = (await tx
      .select({ next: sql<number>`coalesce(max(${configRevisions.revision}), 0) + 1` })
      .from(configRevisions)) as [{ next: number }];
    const [row] = await tx
      .insert(configRevisions)
      .values({
        revision: Number(next),
        config,
        changeKind: params.changeKind,
        changedByAccountId: params.changedByAccountId,
        reason: params.reason,
        isActive: true,
      })
      .returning({ id: configRevisions.id, revision: configRevisions.revision });
    if (!row) throw new Error("Config revision insert returned no row.");
    return row;
  });
  invalidateConfigCache();
  return result;
}

export async function listConfigRevisions(
  db: DbOrTx,
  limit = 20,
): Promise<ConfigRevisionSummary[]> {
  const rows = await db
    .select()
    .from(configRevisions)
    .orderBy(desc(configRevisions.revision))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    revision: row.revision,
    changeKind: row.changeKind,
    reason: row.reason,
    isActive: row.isActive,
    createdAt: row.createdAt,
    preset: String((row.config as { preset?: string }).preset ?? "custom"),
  }));
}

export async function getConfigRevision(
  db: DbOrTx,
  revision: number,
): Promise<AgoraConfig | null> {
  const rows = await db
    .select()
    .from(configRevisions)
    .where(eq(configRevisions.revision, revision))
    .limit(1);
  const row = rows[0];
  return row ? parseConfig(row.config) : null;
}

/** Rollback is a new revision that copies an older one, so history stays linear. */
export async function rollbackConfigTo(
  db: DbOrTx,
  revision: number,
  params: { changedByAccountId: string | null; reason: string },
): Promise<{ revision: number }> {
  const config = await getConfigRevision(db, revision);
  if (!config) throw new Error(`Config revision ${revision} does not exist.`);
  return saveConfigRevision(db, {
    config,
    changeKind: "admin",
    changedByAccountId: params.changedByAccountId,
    reason: params.reason || `Vraćeno na reviziju ${revision}.`,
  });
}
