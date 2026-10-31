import { and, count, desc, eq, gte, inArray, ne } from "drizzle-orm";
import type { Clock } from "@/lib/clock";
import type { AgoraConfig } from "@/lib/config/schema";
import { assembleGenerationContext } from "@/lib/context/assemble";
import { BudgetRefusedError, getBudgetStatus, safeErrorText } from "@/lib/costs/gateway";
import type { Db } from "@/lib/db/client";
import {
  agentActions,
  comments,
  communities,
  personas,
  providerRequests,
  schedulerDecisions,
  threads,
} from "@/lib/db/schema";
import type { Actor } from "@/lib/domain/actors";
import { isTerminal, replayResult, type ActionResult } from "@/lib/domain/actions";
import { addComment } from "@/lib/domain/comments";
import type { ServiceContext } from "@/lib/domain/context";
import { DomainError } from "@/lib/domain/errors";
import { rememberView } from "@/lib/domain/personas";
import { reviseOwnContent } from "@/lib/domain/revisions";
import { isSummaryDue, summarizeThread } from "@/lib/domain/summaries";
import { createThread, type CitationInput } from "@/lib/domain/threads";
import { castVote } from "@/lib/domain/votes";
import { runFreeChecks } from "@/lib/gates/publication-gate";
import {
  ProviderCallError,
  ProviderNotConfiguredError,
  type GateKind,
  type GenerationRequest,
  type Intent,
  type GenerationResult,
} from "@/lib/providers/types";
import { dailyMaxFor } from "@/lib/scheduler/pacing";
import { voteCapPerPersona } from "@/lib/scheduler/eligibility";
import { belgradeDayStart } from "@/lib/time";
import type { ActionJobPayload } from "./types";

export interface JobDeps {
  db: Db;
  clock: Clock;
  /** Fresh configuration for every job. */
  loadConfig(): Promise<AgoraConfig>;
  /** Metered providers; origin "scheduler" in the worker, "simulation" in the simulation. */
  buildContext(config: AgoraConfig): ServiceContext;
  /** 1-based attempt number and the configured maximum. */
  attempt: number;
  maxAttempts: number;
}

export interface JobOutcome {
  outcome: "published" | "quarantined" | "skipped" | "failed";
  code: string | null;
  actionId: string | null;
  resultId: string | null;
}

const skipped = (code: string): JobOutcome => ({
  outcome: "skipped",
  code,
  actionId: null,
  resultId: null,
});

/** Public Serbian reason shown in the revision history. */
const REVISION_REASON = "Dopuna nakon primedbe u raspravi.";
const CLAIM_EXCERPT_CHARS = 200;
const CHALLENGE_EXCERPT_CHARS = 240;
const OUTCOME_CODE_MAX = 60;

type PersonaRow = typeof personas.$inferSelect;

/** A decision's usual "today" counts only content that reached a verdict. */
const COUNTED = ["published", "quarantined"] as const;

async function countDecisions(
  db: Db,
  decisionId: string,
  dayStart: Date,
  filter: ReturnType<typeof eq>,
  kinds: ActionJobPayload["kind"][],
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(schedulerDecisions)
    .where(
      and(
        filter,
        inArray(schedulerDecisions.kind, kinds),
        inArray(schedulerDecisions.outcome, [...COUNTED]),
        gte(schedulerDecisions.createdAt, dayStart),
        ne(schedulerDecisions.id, decisionId),
      ),
    );
  return row?.n ?? 0;
}

async function threadIsPublished(db: Db, threadId: string | null): Promise<boolean> {
  if (!threadId) return false;
  const [row] = await db
    .select({ status: threads.status })
    .from(threads)
    .where(eq(threads.id, threadId))
    .limit(1);
  return row?.status === "published";
}

/** The target's current status, revision and depth, or null when it does not exist. */
async function loadTarget(
  db: Db,
  type: "thread" | "comment",
  id: string,
): Promise<{
  status: string;
  revision: number;
  depth: number;
  authorPersonaId: string;
  threadId: string;
} | null> {
  if (type === "thread") {
    const [row] = await db
      .select({
        status: threads.status,
        revision: threads.revision,
        authorPersonaId: threads.authorPersonaId,
      })
      .from(threads)
      .where(eq(threads.id, id))
      .limit(1);
    return row ? { ...row, depth: -1, threadId: id } : null;
  }
  const [row] = await db
    .select({
      status: comments.status,
      revision: comments.revision,
      depth: comments.depth,
      authorPersonaId: comments.authorPersonaId,
      threadId: comments.threadId,
    })
    .from(comments)
    .where(eq(comments.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * The cheap, free checks every job repeats before acting, because the world
 * may have moved since the scheduler planned it. Returns the skip code.
 */
async function recheck(
  payload: ActionJobPayload,
  deps: JobDeps,
  config: AgoraConfig,
  persona: PersonaRow | null,
): Promise<string | null> {
  const { db, clock } = deps;
  const now = clock.now();
  const { kind } = payload;

  if (config.runtime.pauseAllActions) return "paused";
  if (kind !== "vote" && config.runtime.pausePaidActions) return "paid_paused";
  if (now.getTime() > new Date(payload.notAfter).getTime()) return "stale";
  if (kind !== "vote") {
    // The scheduler stopped planning paid work in the paused stage; a job queued earlier stops too.
    const budget = await getBudgetStatus(db, config, clock);
    if (budget.stage === "paused") return "budget_paused";
  }

  const dayStart = belgradeDayStart(now);
  if (kind !== "summary") {
    if (!persona || persona.isSuspended) return "persona_inactive";
    const mine = eq(schedulerDecisions.personaId, persona.id);
    if (kind === "vote") {
      const [active] = await db
        .select({ n: count() })
        .from(personas)
        .where(eq(personas.isSuspended, false));
      const cap = voteCapPerPersona(config.content.maxVotesPerDay, active?.n ?? 1);
      if ((await countDecisions(db, payload.decisionId, dayStart, mine, ["vote"])) >= cap) {
        return "persona_limit";
      }
    } else {
      const cap = Math.min(
        persona.limits.maxContentActionsPerDay,
        config.personas.maxContentActionsPerPersonaPerDay,
      );
      const used = await countDecisions(db, payload.decisionId, dayStart, mine, [
        "thread",
        "reply",
        "revision",
      ]);
      if (used >= cap) return "persona_limit";
    }

    if (kind === "thread" || kind === "reply") {
      const cooldownMs =
        Math.max(
          persona.limits.replyCooldownMinutes,
          config.personas.minimumReplyCooldownMinutes,
        ) * 60_000;
      const [lastComment] = await db
        .select({ at: comments.createdAt })
        .from(comments)
        .where(and(eq(comments.authorPersonaId, persona.id), eq(comments.status, "published")))
        .orderBy(desc(comments.createdAt))
        .limit(1);
      const [lastThread] = await db
        .select({ at: threads.createdAt })
        .from(threads)
        .where(and(eq(threads.authorPersonaId, persona.id), eq(threads.status, "published")))
        .orderBy(desc(threads.createdAt))
        .limit(1);
      const last = Math.max(lastComment?.at.getTime() ?? 0, lastThread?.at.getTime() ?? 0);
      if (last > 0 && now.getTime() - last < cooldownMs) return "cooldown";
    }
  }

  const globalMax =
    kind === "summary" ? config.content.maxSummariesPerDay : dailyMaxFor(kind, config.content);
  const [used] = await db
    .select({ n: count() })
    .from(schedulerDecisions)
    .where(
      and(
        eq(schedulerDecisions.kind, kind),
        inArray(schedulerDecisions.outcome, [...COUNTED]),
        gte(schedulerDecisions.createdAt, dayStart),
        ne(schedulerDecisions.id, payload.decisionId),
      ),
    );
  if ((used?.n ?? 0) >= globalMax) return "daily_max";

  return recheckContent(payload, deps, config);
}

async function recheckContent(
  payload: ActionJobPayload,
  deps: JobDeps,
  config: AgoraConfig,
): Promise<string | null> {
  const { db } = deps;
  const expected = payload.contentVersion.targetRevision;
  switch (payload.kind) {
    case "thread": {
      if (!payload.communityId) return "content_changed";
      const [row] = await db
        .select({ active: communities.isActive })
        .from(communities)
        .where(eq(communities.id, payload.communityId))
        .limit(1);
      return row?.active ? null : "content_changed";
    }
    case "reply": {
      if (!(await threadIsPublished(db, payload.threadId))) return "content_changed";
      if (!payload.targetId || !payload.targetType) return "content_changed";
      const target = await loadTarget(db, payload.targetType, payload.targetId);
      if (!target || target.status !== "published") return "content_changed";
      if (expected !== undefined && target.revision !== expected) return "content_changed";
      if (payload.targetType === "comment") {
        if (target.threadId !== payload.threadId) return "content_changed";
        if (target.depth + 1 >= config.content.maxCommentDepth) return "content_changed";
      }
      return null;
    }
    case "revision": {
      if (!payload.targetId || !payload.targetType) return "content_changed";
      const target = await loadTarget(db, payload.targetType, payload.targetId);
      if (!target || target.status !== "published") return "content_changed";
      if (expected !== undefined && target.revision !== expected) return "content_changed";
      // The revision quotes the challenging reply; a hidden one must not be quoted.
      if (payload.relatedCommentId) {
        const related = await loadTarget(db, "comment", payload.relatedCommentId);
        if (!related || related.status !== "published") return "content_changed";
      }
      return null;
    }
    case "summary": {
      if (!(await threadIsPublished(db, payload.threadId))) return "content_changed";
      const due = await isSummaryDue(
        db,
        payload.threadId as string,
        config.scheduler.summaryEveryComments,
      );
      return due.due ? null : "not_due";
    }
    case "vote": {
      if (!payload.targetId || !payload.targetType) return "content_changed";
      const target = await loadTarget(db, payload.targetType, payload.targetId);
      return target?.status === "published" ? null : "content_changed";
    }
  }
}

function outcomeCode(codes: string[]): string | null {
  const joined = codes.join(",");
  return joined.length === 0 ? null : joined.slice(0, OUTCOME_CODE_MAX);
}

function fromActionResult(result: ActionResult): JobOutcome {
  if (result.status === "published") {
    return {
      outcome: "published",
      code: null,
      actionId: result.actionId,
      resultId: result.id,
    };
  }
  return {
    outcome: "quarantined",
    code: outcomeCode(result.codes),
    actionId: result.actionId,
    resultId: null,
  };
}

function actorOf(persona: PersonaRow): Actor {
  return { kind: "persona", personaId: persona.id, accountId: persona.accountId };
}

function citationsFor(draft: GenerationResult): CitationInput[] {
  const claim = draft.body.replace(/\s+/g, " ").trim().slice(0, CLAIM_EXCERPT_CHARS);
  return [...new Set(draft.evidenceIds)].map((articleId) => ({
    articleId,
    claimExcerpt: claim,
  }));
}

/** Short Serbian reason for a revision, quoting the reply that challenged the content. */
async function revisionReasonFor(db: Db, relatedCommentId: string | null | undefined) {
  if (!relatedCommentId) return REVISION_REASON;
  const [row] = await db
    .select({ body: comments.body })
    .from(comments)
    .where(and(eq(comments.id, relatedCommentId), eq(comments.status, "published")))
    .limit(1);
  if (!row) return REVISION_REASON;
  const quote = row.body.replace(/\s+/g, " ").trim().slice(0, CHALLENGE_EXCERPT_CHARS);
  return `Odgovor u raspravi je osporio ovaj tekst: „${quote}“. Dopuni ili ispravi tekst tamo gde je primedba opravdana.`;
}

/** A job-level draft check on top of the gate's free checks: only offered facts may be cited. */
function blockingCodes(
  draft: GenerationResult,
  gateKind: GateKind,
  payload: ActionJobPayload,
  ctx: { communitySlug: string; communityName: string; threadTitle?: string },
  offeredFactIds: string[],
  config: AgoraConfig,
  notes: string[],
): string[] {
  const free = runFreeChecks(
    {
      kind: gateKind,
      title: draft.title,
      body: draft.body,
      notes,
      context: {
        communitySlug: ctx.communitySlug,
        communityName: ctx.communityName,
        // A thread must stand on its own topic; replies and revisions of comments inherit it.
        inheritsTopic: payload.kind === "reply" || gateKind === "revision_comment",
        threadTitle: ctx.threadTitle,
      },
      seed: payload.actionKey,
    },
    config,
  );
  const blocking = [...free.blocking];
  const offered = new Set(offeredFactIds);
  if (
    draft.evidenceIds.some((id) => !offered.has(id)) &&
    !blocking.includes("invented_citation")
  ) {
    blocking.push("invented_citation");
  }
  return blocking;
}

/** Generate (plus at most one repair), run the service, return its result. */
async function runContentAction(
  payload: ActionJobPayload,
  persona: PersonaRow,
  config: AgoraConfig,
  ctx: ServiceContext,
  deps: JobDeps,
): Promise<{ result: ActionResult; draft: GenerationResult | null; threadId: string | null }> {
  const { db, clock } = deps;
  const communityId = payload.communityId;
  if (!communityId) throw new DomainError("not_found", "Job has no community.");
  const [community] = await db
    .select()
    .from(communities)
    .where(eq(communities.id, communityId))
    .limit(1);
  if (!community) throw new DomainError("not_found", "Community not found.");

  const isRevision = payload.kind === "revision";
  const actor = actorOf(persona);
  const base = { actor, actionKey: payload.actionKey, intent: payload.intent ?? undefined };

  // A retry after a transient validator failure finds the draft the earlier attempt stored on
  // the proposed action row; submit it again instead of paying for another generation.
  const stored = await storedDraft(db, payload);
  if (stored) {
    const result = await submitDraft(payload, community.slug, actor, base, stored, ctx);
    return {
      result,
      draft: null,
      threadId:
        payload.kind === "thread"
          ? result.status === "published"
            ? result.id
            : null
          : payload.threadId,
    };
  }

  const reason = isRevision ? await revisionReasonFor(db, payload.relatedCommentId) : null;
  const assembled = await assembleGenerationContext(
    db,
    {
      purpose:
        payload.kind === "reply" ? "reply" : payload.kind === "thread" ? "thread" : "revision",
      personaId: persona.id,
      communityId,
      threadId: payload.threadId,
      parentCommentId:
        payload.kind === "reply" && payload.targetType === "comment" ? payload.targetId : null,
      targetType: isRevision ? payload.targetType : null,
      targetId: isRevision ? payload.targetId : null,
      revisionReason: reason,
      topicHint: payload.topicHint,
    },
    clock.now(),
  );

  const targetIsThread = isRevision
    ? payload.targetType === "thread"
    : payload.kind === "thread";
  const maxBodyCharacters = targetIsThread
    ? config.content.maxThreadCharacters
    : config.content.maxCommentCharacters;
  const gateKind: GateKind =
    payload.kind === "thread"
      ? "thread"
      : payload.kind === "reply"
        ? "comment"
        : targetIsThread
          ? "revision_thread"
          : "revision_comment";

  const request: GenerationRequest = {
    purpose:
      payload.kind === "reply" ? "reply" : payload.kind === "thread" ? "thread" : "revision",
    persona: assembled.persona,
    intent: payload.intent ?? (isRevision ? "correct_earlier" : "add_context"),
    context: assembled.context,
    seed: payload.actionKey,
    maxOutputTokens: config.budget.generationMaxBilledOutputTokens,
    maxBodyCharacters,
  };

  const generation = ctx.providers.generation;
  let draft = await generation.generate(request);
  const gateCtx = {
    communitySlug: community.slug,
    communityName: community.name,
    threadTitle: assembled.context.threadTitle,
  };
  const notes = isRevision ? [REVISION_REASON] : [];
  const blocking = blockingCodes(
    draft,
    gateKind,
    payload,
    gateCtx,
    assembled.offeredFactIds,
    config,
    notes,
  );
  if (
    blocking.length > 0 &&
    config.runtime.maxPaidContentRepairs >= 1 &&
    !(await hasRepairRequest(db, payload.actionKey))
  ) {
    try {
      draft = await generation.generate({
        ...request,
        repair: { previousTitle: draft.title, previousBody: draft.body, codes: blocking },
      });
    } catch {
      // The repair is a courtesy: the service quarantines the original draft honestly.
    }
  }

  const submitted = {
    title: draft.title,
    body: draft.body,
    citations: citationsFor(draft),
  };
  const result = await submitDraft(
    payload,
    community.slug,
    actor,
    { ...base, intent: request.intent },
    submitted,
    ctx,
  );
  return {
    result,
    draft,
    threadId:
      payload.kind === "thread"
        ? result.status === "published"
          ? result.id
          : null
        : payload.threadId,
  };
}

interface SubmittedDraft {
  title?: string;
  body: string;
  citations: CitationInput[];
}

/** The draft an earlier attempt stored on this key's still-proposed action row, if any. */
async function storedDraft(db: Db, payload: ActionJobPayload): Promise<SubmittedDraft | null> {
  const [row] = await db
    .select({ status: agentActions.status, payload: agentActions.payload })
    .from(agentActions)
    .where(eq(agentActions.actionKey, payload.actionKey))
    .limit(1);
  if (!row || row.status !== "proposed") return null;
  const stored = row.payload;
  if (typeof stored.body !== "string" || stored.body.length === 0) return null;
  return {
    title: typeof stored.title === "string" ? stored.title : undefined,
    body: stored.body,
    citations: Array.isArray(stored.citations) ? (stored.citations as CitationInput[]) : [],
  };
}

/** At most one paid repair per action, across retries. */
async function hasRepairRequest(db: Db, actionKey: string): Promise<boolean> {
  const [row] = await db
    .select({ n: count() })
    .from(providerRequests)
    .where(
      and(eq(providerRequests.actionKey, actionKey), eq(providerRequests.purpose, "repair")),
    );
  return (row?.n ?? 0) > 0;
}

/** Hands a draft to the domain service for its kind. */
async function submitDraft(
  payload: ActionJobPayload,
  communitySlug: string,
  actor: Actor,
  base: { actor: Actor; actionKey: string; intent?: Intent },
  draft: SubmittedDraft,
  ctx: ServiceContext,
): Promise<ActionResult> {
  if (payload.kind === "thread") {
    return createThread(
      {
        ...base,
        communitySlug,
        title: draft.title ?? "",
        body: draft.body,
        citations: draft.citations,
      },
      ctx,
    );
  }
  if (payload.kind === "reply") {
    if (!payload.threadId) throw new DomainError("not_found", "Reply job has no thread.");
    return addComment(
      {
        ...base,
        threadId: payload.threadId,
        parentCommentId: payload.targetType === "comment" ? payload.targetId : null,
        body: draft.body,
        citations: draft.citations,
      },
      ctx,
    );
  }
  if (!payload.targetId || !payload.targetType) {
    throw new DomainError("not_found", "Revision job has no target.");
  }
  return reviseOwnContent(
    {
      actor,
      actionKey: payload.actionKey,
      targetType: payload.targetType,
      targetId: payload.targetId,
      expectedRevision: payload.contentVersion.targetRevision ?? 1,
      title: payload.targetType === "thread" ? draft.title : undefined,
      body: draft.body,
      reason: REVISION_REASON,
    },
    ctx,
  );
}

async function finishDecision(
  db: Db,
  clock: Clock,
  decisionId: string,
  outcome: JobOutcome,
): Promise<void> {
  await db
    .update(schedulerDecisions)
    .set({
      outcome: outcome.outcome,
      outcomeCode: outcome.code,
      actionId: outcome.actionId,
      completedAt: clock.now(),
    })
    .where(eq(schedulerDecisions.id, decisionId));
}

async function execute(
  payload: ActionJobPayload,
  persona: PersonaRow | null,
  config: AgoraConfig,
  deps: JobDeps,
): Promise<JobOutcome> {
  const { db, clock } = deps;
  const ctx = deps.buildContext(config);

  if (payload.kind === "vote") {
    if (!persona || !payload.targetId || !payload.targetType || !payload.voteValue) {
      return skipped("content_changed");
    }
    const vote = await castVote(
      {
        actor: actorOf(persona),
        targetType: payload.targetType,
        targetId: payload.targetId,
        value: payload.voteValue,
      },
      ctx,
    );
    if (vote.applied === "unchanged") return skipped("already_voted");
    return { outcome: "published", code: null, actionId: null, resultId: payload.targetId };
  }

  if (payload.kind === "summary") {
    if (!payload.threadId) return skipped("content_changed");
    return fromActionResult(
      await summarizeThread({ actionKey: payload.actionKey, threadId: payload.threadId }, ctx),
    );
  }

  if (!persona) return skipped("persona_inactive");

  // A terminal action row means an earlier attempt finished; do not pay for another draft.
  const [earlier] = await db
    .select()
    .from(agentActions)
    .where(eq(agentActions.actionKey, payload.actionKey))
    .limit(1);
  if (earlier && isTerminal(earlier.status)) {
    const replay = replayResult(earlier);
    if (replay) return fromActionResult(replay);
  }

  const { result, draft, threadId } = await runContentAction(
    payload,
    persona,
    config,
    ctx,
    deps,
  );
  if (result.status === "published" && !result.replayed && draft?.memoryNote) {
    try {
      await rememberView(
        db,
        { personaId: persona.id, threadId, content: draft.memoryNote },
        clock.now(),
      );
    } catch {
      // Memory is a convenience; a published action must not fail because of it.
    }
  }
  return fromActionResult(result);
}

/** Notes the failed attempt on the action row so the admin sees why a retry happened. */
async function noteAttemptError(db: Db, payload: ActionJobPayload, message: string) {
  await db
    .update(agentActions)
    .set({ error: message })
    .where(
      and(
        eq(agentActions.actionKey, payload.actionKey),
        inArray(agentActions.status, ["proposed", "validated"]),
      ),
    );
}

/**
 * Runs one planned decision: re-checks it against the current world, executes
 * it through the domain services, and records the outcome on the decision.
 * Errors that a retry could fix are rethrown for the queue.
 */
export async function executeActionJob(
  payload: ActionJobPayload,
  deps: JobDeps,
): Promise<JobOutcome> {
  const { db, clock } = deps;
  const [decision] = await db
    .select({ outcome: schedulerDecisions.outcome })
    .from(schedulerDecisions)
    .where(eq(schedulerDecisions.id, payload.decisionId))
    .limit(1);
  if (!decision) return skipped("no_decision");
  if (decision.outcome !== "queued") return skipped("already_done");

  const settle = async (outcome: JobOutcome) => {
    await finishDecision(db, clock, payload.decisionId, outcome);
    return outcome;
  };

  const config = await deps.loadConfig();
  let persona: PersonaRow | null = null;
  if (payload.personaId) {
    const [row] = await db
      .select()
      .from(personas)
      .where(eq(personas.id, payload.personaId))
      .limit(1);
    persona = row ?? null;
  }

  const code = await recheck(payload, deps, config, persona);
  if (code) return settle(skipped(code));

  try {
    return await settle(await execute(payload, persona, config, deps));
  } catch (error) {
    if (error instanceof DomainError) {
      const detail = error.details.code;
      return settle(skipped(typeof detail === "string" ? detail : error.code));
    }
    if (error instanceof BudgetRefusedError) {
      if (error.reason === "busy") throw error;
      return settle(skipped(`budget_${error.reason}`));
    }
    if (error instanceof ProviderNotConfiguredError) {
      return settle({ ...skipped("provider_not_configured"), outcome: "failed" });
    }
    if (error instanceof ProviderCallError && !error.retryable) {
      const detail = error.details.code ?? "error";
      return settle({
        outcome: "failed",
        code: `provider_${detail}`.slice(0, OUTCOME_CODE_MAX),
        actionId: null,
        resultId: null,
      });
    }
    await noteAttemptError(
      db,
      payload,
      `attempt ${deps.attempt}/${deps.maxAttempts}: ${safeErrorText(error)}`,
    ).catch(() => {});
    throw error;
  }
}
