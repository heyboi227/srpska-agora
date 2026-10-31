import { and, eq, inArray } from "drizzle-orm";
import type { Clock } from "@/lib/clock";
import type { Db } from "@/lib/db/client";
import { agentActions, schedulerDecisions } from "@/lib/db/schema";
import type { ActionJobPayload } from "./types";

const ERROR_MAX = 500;

/**
 * Called when a job has used all its attempts. The decision becomes failed,
 * and a content action that never reached a verdict is closed with the error,
 * so nothing stays "queued" or "proposed" forever.
 */
export async function recordDeadLetter(
  db: Db,
  clock: Clock,
  payload: ActionJobPayload,
  errorMessage: string,
): Promise<void> {
  const now = clock.now();
  await db
    .update(schedulerDecisions)
    .set({ outcome: "failed", outcomeCode: "dead_letter", completedAt: now })
    .where(
      and(
        eq(schedulerDecisions.id, payload.decisionId),
        // A decision that already reached a verdict keeps it.
        eq(schedulerDecisions.outcome, "queued"),
      ),
    );
  await db
    .update(agentActions)
    .set({ status: "failed", error: errorMessage.slice(0, ERROR_MAX), completedAt: now })
    .where(
      and(
        eq(agentActions.actionKey, payload.actionKey),
        inArray(agentActions.status, ["proposed", "validated"]),
      ),
    );
}
