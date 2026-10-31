import { and, desc, eq, gt } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import { personaMemories, threads } from "@/lib/db/schema";
import { clip } from "./budget";

export interface MemoryCandidate {
  content: string;
  threadId: string | null;
  /** Community of the memory's thread, when it has one. */
  communityId: string | null;
  createdAt: Date;
}

export interface MemoryLimits {
  items: number;
  totalChars: number;
  itemChars: number;
}

/**
 * Ranks memories for one generation: same thread first, then same community,
 * then the rest; newest first inside each group. Each entry is truncated, and
 * the list stops at the item and total-character limits.
 */
export function rankMemories(
  candidates: MemoryCandidate[],
  focus: { threadId?: string | null; communityId?: string | null },
  limits: MemoryLimits,
): string[] {
  const group = (item: MemoryCandidate): number => {
    if (focus.threadId && item.threadId === focus.threadId) return 0;
    if (focus.communityId && item.communityId === focus.communityId) return 1;
    return 2;
  };
  const ordered = [...candidates].sort(
    (a, b) => group(a) - group(b) || b.createdAt.getTime() - a.createdAt.getTime(),
  );
  const picked: string[] = [];
  let total = 0;
  for (const item of ordered) {
    if (picked.length >= limits.items) break;
    const text = clip(item.content.replace(/\s+/g, " ").trim(), limits.itemChars);
    if (text.length === 0) continue;
    if (total + text.length > limits.totalChars) break;
    picked.push(text);
    total += text.length;
  }
  return picked;
}

/** Non-expired memories of a persona, ranked for the thread and community at hand. */
export async function selectPersonaMemories(
  db: DbOrTx,
  params: {
    personaId: string;
    threadId?: string | null;
    communityId?: string | null;
    now: Date;
  },
  limits: MemoryLimits = { items: 8, totalChars: 800, itemChars: 200 },
): Promise<string[]> {
  const rows = await db
    .select({
      content: personaMemories.content,
      threadId: personaMemories.threadId,
      communityId: threads.communityId,
      createdAt: personaMemories.createdAt,
    })
    .from(personaMemories)
    .leftJoin(threads, eq(threads.id, personaMemories.threadId))
    .where(
      and(
        eq(personaMemories.personaId, params.personaId),
        gt(personaMemories.expiresAt, params.now),
      ),
    )
    .orderBy(desc(personaMemories.createdAt))
    .limit(100);
  return rankMemories(rows, params, limits);
}
