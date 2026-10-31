import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { STANDARD_PRESET } from "@/lib/config/presets";
import type { AgoraConfig } from "@/lib/config/schema";
import { ManualClock } from "@/lib/clock";
import { CostGateway, meterProviders, type PriceTable } from "@/lib/costs";
import type { Db } from "@/lib/db/client";
import { communities, schedulerDecisions, schedulerRuns } from "@/lib/db/schema";
import type { Actor } from "@/lib/domain/actors";
import { addComment } from "@/lib/domain/comments";
import { buildServiceContext, type ServiceContext } from "@/lib/domain/context";
import { createThread } from "@/lib/domain/threads";
import type { JobDeps } from "@/lib/jobs/handlers";
import type { ActionJobPayload, ActionKind } from "@/lib/jobs/types";
import { createProviders } from "@/lib/providers";
import type {
  GenerationRequest,
  GenerationResult,
  ProviderSet,
  ValidationRequest,
  ValidationVerdict,
} from "@/lib/providers/types";
import { SERBIAN_THREAD, seedMinimal, type MinimalFixture } from "./helpers";

export const SERBIAN_COMMENT =
  "Slažem se, a kod nas u Vojvodini ajvar se čuva u tamnoj ostavi, u tegli sa čvrstim poklopcem. Iskustvo je pokazalo da toplota najviše kvari ukus.";
export const ENGLISH_COMMENT =
  "This is a perfectly ordinary English sentence about keeping the pepper spread in a dark cellar all winter long.";

/** Wraps the mock generator so a test can script individual responses and see every request. */
export class ScriptedGeneration {
  readonly name = "mock";
  readonly model = "mock-deterministic-v1";
  readonly configured = true;
  readonly requests: GenerationRequest[] = [];
  /** Return a result to replace the mock's, or undefined to fall through. */
  script: ((request: GenerationRequest, call: number) => GenerationResult | undefined) | null =
    null;

  constructor(private readonly inner = createProviders("mock").generation) {}

  async generate(request: GenerationRequest, signal?: AbortSignal): Promise<GenerationResult> {
    this.requests.push(request);
    const scripted = this.script?.(request, this.requests.length);
    if (scripted) return scripted;
    return this.inner.generate(request, signal);
  }
}

export class ScriptedValidation {
  readonly name = "mock";
  readonly model = "mock-deterministic-v1";
  readonly configured = true;
  reject = false;
  /** When set, every call throws it until the test clears it. */
  failWith: Error | null = null;
  calls = 0;

  constructor(private readonly inner = createProviders("mock").validation) {}

  async validate(request: ValidationRequest, signal?: AbortSignal): Promise<ValidationVerdict> {
    this.calls += 1;
    if (this.failWith) throw this.failWith;
    const verdict = await this.inner.validate(request, signal);
    if (!this.reject) return verdict;
    return { ...verdict, verdict: "reject", reasons: ["validator:off_topic"] };
  }
}

export interface JobHarness {
  db: Db;
  clock: ManualClock;
  config: AgoraConfig;
  gen: ScriptedGeneration;
  val: ScriptedValidation;
  providers: ProviderSet;
  people: MinimalFixture;
  communityId: string;
  threadId: string;
  /** B's top-level comment on the thread. */
  commentId: string;
  deps(over?: Partial<JobDeps>): JobDeps;
  plan(kind: ActionKind, over?: Partial<ActionJobPayload>): Promise<ActionJobPayload>;
}

export function jobsConfig(over: (c: AgoraConfig) => void = () => {}): AgoraConfig {
  const config = structuredClone(STANDARD_PRESET);
  config.content.maxNewThreadsPerDay = 50;
  config.content.maxNewCommentsPerDay = 500;
  config.content.maxRevisionsPerDay = 50;
  config.content.maxSummariesPerDay = 20;
  config.content.maxVotesPerDay = 1000;
  config.content.maxCommentDepth = 8;
  config.personas.maxContentActionsPerPersonaPerDay = 50;
  config.runtime.maxPendingJobs = 1000;
  config.scheduler.summaryEveryComments = 2;
  over(config);
  return config;
}

/**
 * One community, two personas, a thread by A and a comment by B, all through the
 * real services at 08:00 Belgrade; the clock then moves on to 09:30 so cooldowns
 * have passed. Providers are the mock ones, metered by the real cost gateway.
 */
export async function jobHarness(
  db: Db,
  options: { config?: AgoraConfig; prices?: PriceTable } = {},
): Promise<JobHarness> {
  const clock = new ManualClock(new Date("2026-09-10T06:00:00Z"));
  const config = options.config ?? jobsConfig();
  const gen = new ScriptedGeneration();
  const val = new ScriptedValidation();
  const search = createProviders("mock").search;
  const providers = meterProviders(
    { mode: "mock", generation: gen, validation: val, search },
    new CostGateway({ db, config, clock, prices: options.prices }),
    "simulation",
  );
  const seedCtx: ServiceContext = buildServiceContext({
    db,
    config,
    clock,
    providers: createProviders("mock"),
  });
  const people = await seedMinimal(seedCtx);
  const created = await createThread(
    {
      actor: people.personaA as Actor,
      actionKey: "fx:thread",
      communitySlug: people.communitySlug,
      title: SERBIAN_THREAD.title,
      body: SERBIAN_THREAD.body,
    },
    seedCtx,
  );
  if (created.status !== "published") throw new Error("fixture thread not published");
  clock.advance(60_000);
  const comment = await addComment(
    {
      actor: people.personaB as Actor,
      actionKey: "fx:comment",
      threadId: created.id,
      body: SERBIAN_COMMENT,
    },
    seedCtx,
  );
  if (comment.status !== "published") throw new Error("fixture comment not published");
  clock.set(new Date("2026-09-10T07:30:00Z"));
  const [community] = await db
    .select({ id: communities.id })
    .from(communities)
    .where(eq(communities.slug, people.communitySlug));
  const communityId = community?.id ?? "";

  let seq = 0;
  const harness: JobHarness = {
    db,
    clock,
    config,
    gen,
    val,
    providers,
    people,
    communityId,
    threadId: created.id,
    commentId: comment.id,
    deps: (over = {}) => ({
      db,
      clock,
      loadConfig: async () => config,
      buildContext: (cfg) =>
        buildServiceContext({ db, config: cfg, clock, origin: "simulation", providers }),
      attempt: 1,
      maxAttempts: config.runtime.maxAutomaticJobAttempts,
      ...over,
    }),
    async plan(kind, over = {}) {
      const now = clock.now();
      const [run] = await db
        .insert(schedulerRuns)
        .values({ tickAt: now, createdAt: now, state: "planned", budgetStage: "normal" })
        .returning({ id: schedulerRuns.id });
      const decisionId = randomUUID();
      seq += 1;
      const payload: ActionJobPayload = {
        decisionId,
        actionKey: `test:${seq}:${kind}`,
        kind,
        personaId: people.personaAId,
        communityId,
        threadId: created.id,
        targetId: null,
        targetType: null,
        intent: null,
        voteValue: null,
        topicHint: null,
        relatedCommentId: null,
        contentVersion: {},
        plannedAt: now.toISOString(),
        notAfter: new Date(now.getTime() + 30 * 60_000).toISOString(),
        ...over,
      };
      await db.insert(schedulerDecisions).values({
        id: decisionId,
        runId: run?.id ?? "",
        kind,
        actionKey: payload.actionKey,
        personaId: payload.personaId,
        communityId: payload.communityId,
        threadId: payload.threadId,
        targetId: payload.targetId,
        intent: payload.intent,
        score: 1,
        breakdown: { features: [], base: 1, stageFactor: 1, total: 1 },
        outcome: "queued",
        notAfter: new Date(payload.notAfter),
        createdAt: now,
      });
      return payload;
    },
  };
  return harness;
}
