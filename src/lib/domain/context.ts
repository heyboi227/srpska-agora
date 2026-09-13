import type { AgoraConfig } from "@/lib/config/schema";
import { getActiveConfig } from "@/lib/config/service";
import { getDb, type Db } from "@/lib/db/client";
import { getEnv } from "@/lib/env";
import { createProviders, type ProviderSet } from "@/lib/providers";
import { DomainError } from "./errors";

/**
 * Everything a domain service needs, assembled once per request or per
 * scheduler tick. Tests build one with a preset config and mock providers.
 */
export interface ServiceContext {
  db: Db;
  config: AgoraConfig;
  providers: ProviderSet;
  now(): Date;
}

export async function createServiceContext(
  overrides: Partial<ServiceContext> = {},
): Promise<ServiceContext> {
  const db = overrides.db ?? getDb();
  const config = overrides.config ?? (await getActiveConfig(db));
  const providers =
    overrides.providers ??
    createProviders(config.runtime.mode, { openaiApiKey: getEnv().OPENAI_API_KEY });
  return { db, config, providers, now: overrides.now ?? (() => new Date()) };
}

/** Persona-originated actions stop while the administrator has paused the forum. */
export function assertNotPaused(config: AgoraConfig): void {
  if (config.runtime.pauseAllActions) {
    throw new DomainError("paused", "Sve akcije sagovornika su pauzirane.");
  }
}
