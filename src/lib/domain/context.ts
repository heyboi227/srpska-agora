import { systemClock, type Clock } from "@/lib/clock";
import type { AgoraConfig } from "@/lib/config/schema";
import { getActiveConfig } from "@/lib/config/service";
import { CostGateway, type CallOrigin } from "@/lib/costs/gateway";
import { meterProviders } from "@/lib/costs/metered";
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
  /** Who is making provider calls; recorded on every provider request. */
  origin: CallOrigin;
  /**
   * How the publication gate treats a transient validator failure. Queued
   * origins (scheduler, simulation) rethrow so the job retries; everything
   * else quarantines. Default "quarantine".
   */
  transientValidatorErrors?: "quarantine" | "throw";
  now(): Date;
}

export async function createServiceContext(
  overrides: Partial<ServiceContext> & { clock?: Clock } = {},
): Promise<ServiceContext> {
  const db = overrides.db ?? getDb();
  const config = overrides.config ?? (await getActiveConfig(db));
  return buildServiceContext({ ...overrides, db, config });
}

/** The synchronous half of createServiceContext, for callers that already hold the configuration. */
export function buildServiceContext(
  overrides: Partial<ServiceContext> & { db: Db; config: AgoraConfig; clock?: Clock },
): ServiceContext {
  const { db, config } = overrides;
  const origin = overrides.origin ?? "system";
  const clock = overrides.clock ?? systemClock;
  // Providers built here are metered by the cost gateway; a caller that passes
  // its own providers decides for itself (tests, the seed script).
  const providers =
    overrides.providers ??
    meterProviders(
      createProviders(config.runtime.mode, { openaiApiKey: getEnv().OPENAI_API_KEY }),
      new CostGateway({ db, config, clock }),
      origin,
    );
  const transientValidatorErrors =
    overrides.transientValidatorErrors ??
    (origin === "scheduler" || origin === "simulation" ? "throw" : "quarantine");
  return {
    db,
    config,
    providers,
    origin,
    transientValidatorErrors,
    now: overrides.now ?? (() => clock.now()),
  };
}

/** Persona-originated actions stop while the administrator has paused the forum. */
export function assertNotPaused(config: AgoraConfig): void {
  if (config.runtime.pauseAllActions) {
    throw new DomainError("paused", "Sve akcije sagovornika su pauzirane.");
  }
}
