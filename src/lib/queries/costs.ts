import { desc } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import { providerRequests } from "@/lib/db/schema";

const usdFormatter = new Intl.NumberFormat("sr-Latn-RS", {
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

/** Integer micro-USD as a "0,0123 USD" string with four decimals. */
export function formatMicrosUsd(micros: number | null | undefined): string {
  if (micros === null || micros === undefined) return "—";
  return `${usdFormatter.format(micros / 1_000_000)} USD`;
}

export const REQUEST_STATUS_LABELS: Record<string, string> = {
  reserved: "rezervisano",
  succeeded: "uspelo",
  failed: "nije uspelo",
  ambiguous: "neizvesno",
  rejected: "odbijeno",
};

export const PURPOSE_LABELS: Record<string, string> = {
  generation: "generisanje",
  repair: "popravka",
  validation: "provera",
  search: "pretraga",
};

export const ORIGIN_LABELS: Record<string, string> = {
  scheduler: "raspoređivač",
  admin: "administrator",
  system: "sistem",
  eval: "procena",
  simulation: "simulacija",
};

export const REJECT_REASON_LABELS: Record<string, string> = {
  paid_paused: "plaćeni rad je pauziran",
  budget_exhausted: "budžet je potrošen",
  no_price: "nema cene za model",
  busy: "zauzeto",
};

export function listRecentProviderRequests(db: DbOrTx, limit = 50) {
  return db
    .select()
    .from(providerRequests)
    .orderBy(desc(providerRequests.createdAt))
    .limit(limit);
}
