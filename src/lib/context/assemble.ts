import { and, desc, eq, notInArray } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import { comments, communities, personas, threads } from "@/lib/db/schema";
import { DomainError } from "@/lib/domain/errors";
import { getLatestSummary } from "@/lib/domain/summaries";
import type {
  ConversationTurn,
  GenerationPurpose,
  GenerationRequest,
  PersonaBrief,
} from "@/lib/providers/types";
import { clip, fitContextSections, sectionSizes, type ContextSections } from "./budget";
import { loadThreadFacts } from "./facts";
import { CONTEXT_LIMITS, type ContextLimits } from "./limits";
import { selectPersonaMemories } from "./memory";

export { CONTEXT_LIMITS, type ContextLimits };

export interface AssembleParams {
  purpose: GenerationPurpose;
  personaId: string;
  communityId: string;
  threadId?: string | null;
  parentCommentId?: string | null;
  /** Revision target. */
  targetType?: "thread" | "comment" | null;
  targetId?: string | null;
  revisionReason?: string | null;
  topicHint?: string | null;
}

export interface AssembledContext {
  persona: PersonaBrief;
  context: GenerationRequest["context"];
  /** Ids of the facts given to the model; the gate checks claimed evidence against them. */
  offeredFactIds: string[];
  stats: { sections: Record<string, number>; totalChars: number; trimmed: string[] };
}

function oneLine(text: string, max: number): string {
  return clip(text.replace(/\s+/g, " ").trim(), max);
}

/**
 * Builds the bounded context for one generation from published content only.
 * Nothing from other threads is included except the persona's own memory.
 */
export async function assembleGenerationContext(
  db: DbOrTx,
  params: AssembleParams,
  now: Date,
  limits: ContextLimits = CONTEXT_LIMITS,
): Promise<AssembledContext> {
  const personaRows = await db
    .select()
    .from(personas)
    .where(eq(personas.id, params.personaId))
    .limit(1);
  const personaRow = personaRows[0];
  if (!personaRow) throw new DomainError("not_found", "Persona not found.");
  const persona: PersonaBrief = {
    id: personaRow.id,
    slug: personaRow.slug,
    displayName: personaRow.displayName,
    style: personaRow.style,
    scriptPreference: personaRow.scriptPreference,
    vocabularyNotes: personaRow.vocabularyNotes,
    interests: personaRow.interests,
  };

  const communityRows = await db
    .select()
    .from(communities)
    .where(eq(communities.id, params.communityId))
    .limit(1);
  const communityRow = communityRows[0];
  if (!communityRow) throw new DomainError("not_found", "Community not found.");

  // A revision names its target; the thread follows from it when not given.
  let threadId = params.threadId ?? null;
  let currentBody: string | undefined;
  if (params.targetType && params.targetId) {
    if (params.targetType === "thread") {
      threadId ??= params.targetId;
      const rows = await db
        .select({ body: threads.body, status: threads.status })
        .from(threads)
        .where(eq(threads.id, params.targetId))
        .limit(1);
      if (rows[0]?.status !== "published") {
        throw new DomainError("not_found", "Revision target not found or not published.");
      }
      currentBody = rows[0].body;
    } else {
      const rows = await db
        .select({ body: comments.body, status: comments.status, threadId: comments.threadId })
        .from(comments)
        .where(eq(comments.id, params.targetId))
        .limit(1);
      if (rows[0]?.status !== "published") {
        throw new DomainError("not_found", "Revision target not found or not published.");
      }
      currentBody = rows[0].body;
      threadId ??= rows[0].threadId;
    }
  }

  let threadTitle: string | undefined;
  let threadBody: string | undefined;
  let threadSummary: string | undefined;
  let parentChain: ConversationTurn[] = [];
  let recentComments: ConversationTurn[] = [];
  let facts: Awaited<ReturnType<typeof loadThreadFacts>> = [];

  if (threadId) {
    const threadRows = await db
      .select({
        title: threads.title,
        body: threads.body,
        status: threads.status,
        communityId: threads.communityId,
      })
      .from(threads)
      .where(eq(threads.id, threadId))
      .limit(1);
    const thread = threadRows[0];
    if (!thread || thread.communityId !== params.communityId) {
      throw new DomainError("not_found", "Thread not found in this community.");
    }
    if (thread.status !== "published") {
      throw new DomainError("forbidden", "Context is only built for published threads.");
    }
    threadTitle = thread.title;
    // Replies need the post they answer; the thread is published, so its body is too.
    if (params.purpose === "reply") threadBody = oneLine(thread.body, limits.threadBody);

    const summary = await getLatestSummary(db, threadId);
    if (summary) threadSummary = oneLine(summary.body, limits.summary);

    // Walk up from the parent; a comment that is not published ends the chain.
    const chainIds: string[] = [];
    const chainNewestFirst: ConversationTurn[] = [];
    let cursor = params.parentCommentId ?? null;
    while (cursor && chainNewestFirst.length < limits.parentChainItems) {
      const rows = await db
        .select({
          parentCommentId: comments.parentCommentId,
          body: comments.body,
          status: comments.status,
          threadId: comments.threadId,
          author: personas.displayName,
        })
        .from(comments)
        .innerJoin(personas, eq(personas.id, comments.authorPersonaId))
        .where(eq(comments.id, cursor))
        .limit(1);
      const row = rows[0];
      if (!row || row.threadId !== threadId || row.status !== "published") break;
      chainIds.push(cursor);
      chainNewestFirst.push({
        author: row.author,
        body: oneLine(row.body, limits.parentChainItemChars),
      });
      cursor = row.parentCommentId;
    }
    parentChain = chainNewestFirst.reverse();

    const recent = await db
      .select({ body: comments.body, author: personas.displayName })
      .from(comments)
      .innerJoin(personas, eq(personas.id, comments.authorPersonaId))
      .where(
        and(
          eq(comments.threadId, threadId),
          eq(comments.status, "published"),
          chainIds.length > 0 ? notInArray(comments.id, chainIds) : undefined,
        ),
      )
      .orderBy(desc(comments.createdAt), desc(comments.id))
      .limit(limits.recentComments);
    recentComments = recent
      .map((row) => ({
        author: row.author,
        body: oneLine(row.body, limits.recentCommentChars),
      }))
      .reverse();

    facts = await loadThreadFacts(db, threadId, limits.facts, limits.factSummaryChars);
  }

  const memory = await selectPersonaMemories(
    db,
    {
      personaId: params.personaId,
      threadId,
      communityId: params.communityId,
      now,
    },
    {
      items: limits.memoryItems,
      totalChars: limits.memoryTotalChars,
      itemChars: limits.memoryItemChars,
    },
  );

  const raw: ContextSections = {
    community: {
      slug: communityRow.slug,
      name: communityRow.name,
      description: oneLine(communityRow.description, limits.community),
    },
    threadTitle,
    threadBody,
    parentChain,
    currentBody,
    revisionReason: currentBody ? (params.revisionReason ?? undefined) : undefined,
    threadSummary,
    facts,
    recentComments,
    memory,
    topicHint: params.topicHint ?? undefined,
  };
  const fitted = fitContextSections(raw, limits.totalChars);
  const s = fitted.sections;

  const context: GenerationRequest["context"] = { community: s.community };
  if (s.topicHint) context.topicHint = s.topicHint;
  if (s.threadTitle) context.threadTitle = s.threadTitle;
  if (s.threadBody) context.threadBody = s.threadBody;
  if (s.threadSummary) context.threadSummary = s.threadSummary;
  if (s.parentChain.length > 0) context.parentChain = s.parentChain;
  if (s.recentComments.length > 0) context.recentComments = s.recentComments;
  if (s.facts.length > 0) context.facts = s.facts;
  if (s.memory.length > 0) context.memory = s.memory;
  if (s.currentBody) context.currentBody = s.currentBody;
  if (s.revisionReason) context.revisionReason = s.revisionReason;

  const sections = sectionSizes(s);
  return {
    persona,
    context,
    offeredFactIds: s.facts.map((fact) => fact.id),
    stats: {
      sections,
      totalChars: Object.values(sections).reduce((sum, size) => sum + size, 0),
      trimmed: fitted.trimmed,
    },
  };
}
