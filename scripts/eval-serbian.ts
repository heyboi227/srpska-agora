import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { and, desc, eq, ne } from "drizzle-orm";
import { systemClock } from "@/lib/clock";
import { getActiveConfig } from "@/lib/config/service";
import type { AgoraConfig } from "@/lib/config/schema";
import { assembleGenerationContext } from "@/lib/context/assemble";
import {
  BudgetRefusedError,
  CostGateway,
  PRICE_TABLE,
  actualCostMicros,
  estimateInputTokens,
  estimateUpperBoundMicros,
  findPrice,
  meterProviders,
} from "@/lib/costs";
import { createDb } from "@/lib/db/client";
import { comments, communityMemberships, personas, threads } from "@/lib/db/schema";
import { dialectAdherence, detectDialect, expectedDialect } from "@/lib/eval/dialect";
import {
  evaluateBar,
  summarizeCorpus,
  summarizeEffort,
  type CallRecord,
  type CorpusResult,
  type CorpusSummary,
  type EffortSummary,
  type EvalPurpose,
  type EvalSample,
} from "@/lib/eval/summary";
import { getEnv, loadDotEnv } from "@/lib/env";
import { runFreeChecks, type GateInput } from "@/lib/gates/publication-gate";
import { createProviders } from "@/lib/providers";
import type { ReasoningEffort } from "@/lib/providers/openai";
import {
  ProviderCallError,
  type GenerationRequest,
  type ProviderSet,
  type Usage,
  type ValidationRequest,
} from "@/lib/providers/types";
import { VALIDATION_CORPUS } from "@/fixtures/validation-corpus";

/**
 * Serbian evaluation: does the live model write and judge Serbian well enough
 * to adopt? `--dry-run` uses the mock providers and exercises the whole
 * pipeline at zero cost. Without it, the OpenAI key and a USD cap are required.
 */

const EFFORTS: readonly ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];

interface Options {
  dryRun: boolean;
  efforts: ReasoningEffort[];
  maxUsd: number;
  personas: number | null;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    dryRun: false,
    efforts: ["none", "low"],
    maxUsd: 0.5,
    personas: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--efforts") {
      const list = next()
        .split(",")
        .map((s) => s.trim());
      for (const e of list) {
        if (!EFFORTS.includes(e as ReasoningEffort)) throw new Error(`Unknown effort: ${e}`);
      }
      opts.efforts = list as ReasoningEffort[];
    } else if (arg === "--max-usd") {
      opts.maxUsd = Number(next());
      if (!(opts.maxUsd > 0)) throw new Error("--max-usd must be a positive number");
    } else if (arg === "--personas") {
      opts.personas = Number(next());
      if (!Number.isInteger(opts.personas) || opts.personas < 1) {
        throw new Error("--personas must be a positive integer");
      }
    } else if (arg !== "--") throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

/** Thrown to end the run early (cap reached or the gateway refused). */
class StopRun extends Error {}

class Runner {
  spentMicros = 0;
  stoppedReason: string | null = null;

  constructor(
    private readonly capMicros: number,
    private readonly providersFor: (effort: ReasoningEffort) => ProviderSet,
  ) {}

  /** Runs one metered call after checking the cap against its upper-bound estimate. */
  async call<T extends { usage: Usage }>(
    effort: ReasoningEffort,
    purpose: CallRecord["purpose"],
    request: GenerationRequest | ValidationRequest,
  ): Promise<{ result?: T; record: CallRecord }> {
    const providers = this.providersFor(effort);
    const target = purpose === "validation" ? providers.validation : providers.generation;
    const price = findPrice(PRICE_TABLE, target.name, target.model);
    const estimate = price
      ? estimateUpperBoundMicros(price, estimateInputTokens(request), request.maxOutputTokens)
      : 0;
    if (this.spentMicros + estimate > this.capMicros) {
      this.stoppedReason = `the next call could cost up to USD ${(estimate / 1e6).toFixed(4)} and would pass the cap (spent USD ${(this.spentMicros / 1e6).toFixed(4)})`;
      throw new StopRun(this.stoppedReason);
    }
    const priceMicros = (usage: Usage) => (price ? actualCostMicros(price, usage) : 0);
    try {
      const result = (await (purpose === "validation"
        ? providers.validation.validate(request as ValidationRequest)
        : providers.generation.generate(request as GenerationRequest))) as unknown as T;
      const micros = priceMicros(result.usage);
      this.spentMicros += micros;
      return {
        result,
        record: { purpose, usage: result.usage, costUsd: micros / 1e6, incomplete: false },
      };
    } catch (error) {
      if (error instanceof BudgetRefusedError) {
        this.stoppedReason = `the cost gateway refused the call (${error.reason})`;
        throw new StopRun(this.stoppedReason);
      }
      const details = error instanceof ProviderCallError ? error.details : {};
      const usage: Usage = details.usage ?? {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        estimatedCostUsd: 0,
      };
      let micros = details.usage ? priceMicros(details.usage) : 0;
      // An unknown outcome may have cost money: count the full estimate.
      if (
        error instanceof ProviderCallError
          ? error.billing === "ambiguous" && !details.usage
          : true
      ) {
        micros = estimate;
      }
      this.spentMicros += micros;
      return {
        record: {
          purpose,
          usage,
          costUsd: micros / 1e6,
          incomplete: details.code?.startsWith("incomplete:") ?? false,
          error: error instanceof Error ? error.message.slice(0, 200) : "unknown error",
        },
      };
    }
  }
}

interface PersonaInput {
  id: string;
  slug: string;
  scriptPreference: "Latin" | "Cyrillic";
  vocabularyNotes: string;
  interests: string[];
  communityId: string;
}

async function loadPersonaInputs(
  db: ReturnType<typeof createDb>["db"],
  limit: number | null,
): Promise<PersonaInput[]> {
  const rows = await db
    .select({
      id: personas.id,
      slug: personas.slug,
      scriptPreference: personas.scriptPreference,
      vocabularyNotes: personas.vocabularyNotes,
      interests: personas.interests,
    })
    .from(personas)
    .orderBy(personas.slug);
  const out: PersonaInput[] = [];
  for (const row of rows) {
    const home = await db
      .select({ communityId: communityMemberships.communityId })
      .from(communityMemberships)
      .where(eq(communityMemberships.personaId, row.id))
      .orderBy(desc(communityMemberships.affinity), communityMemberships.communityId)
      .limit(1);
    if (home[0]) out.push({ ...row, communityId: home[0].communityId });
  }
  return limit ? out.slice(0, limit) : out;
}

async function findReplyTarget(
  db: ReturnType<typeof createDb>["db"],
  persona: PersonaInput,
): Promise<{ threadId: string; commentId: string } | null> {
  const rows = await db
    .select({ threadId: comments.threadId, commentId: comments.id })
    .from(comments)
    .innerJoin(threads, eq(threads.id, comments.threadId))
    .where(
      and(
        eq(threads.communityId, persona.communityId),
        eq(threads.status, "published"),
        eq(comments.status, "published"),
        ne(comments.authorPersonaId, persona.id),
      ),
    )
    .orderBy(desc(comments.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

function gateInputFor(
  purpose: EvalPurpose,
  draft: { title?: string; body: string; evidenceIds: string[] },
  ctx: Awaited<ReturnType<typeof assembleGenerationContext>>,
  seed: string,
): GateInput {
  const community = ctx.context.community;
  return {
    kind: purpose === "thread" ? "thread" : "comment",
    title: draft.title,
    body: draft.body,
    context: {
      communitySlug: community.slug,
      communityName: community.name,
      inheritsTopic: purpose === "reply",
      threadTitle: ctx.context.threadTitle,
      parentExcerpt: ctx.context.parentChain?.at(-1)?.body.slice(0, 300),
    },
    evidence: (ctx.context.facts ?? []).map((f) => ({
      id: f.id,
      title: f.title,
      summary: f.summary,
    })),
    claimedEvidenceIds: draft.evidenceIds,
    seed,
  };
}

async function runSample(
  runner: Runner,
  db: ReturnType<typeof createDb>["db"],
  config: AgoraConfig,
  persona: PersonaInput,
  purpose: EvalPurpose,
  effort: ReasoningEffort,
  runId: string,
  now: Date,
): Promise<EvalSample | null> {
  const tag = `eval:${runId}:${persona.slug.slice(0, 24)}:${purpose[0]}:${effort}`;
  const target = purpose === "reply" ? await findReplyTarget(db, persona) : null;
  if (purpose === "reply" && !target) return null;

  const ctx = await assembleGenerationContext(
    db,
    {
      purpose,
      personaId: persona.id,
      communityId: persona.communityId,
      threadId: target?.threadId,
      parentCommentId: target?.commentId,
      topicHint: purpose === "thread" ? persona.interests[0] : null,
    },
    now,
  );
  const expectedScript = persona.scriptPreference;
  const maxOutputTokens = effort === "none" ? 2500 : 6000;
  const baseRequest: GenerationRequest = {
    purpose,
    persona: ctx.persona,
    intent: purpose === "thread" ? "introduce_topic" : "add_context",
    context: ctx.context,
    seed: `${tag}:g`,
    maxOutputTokens,
    maxBodyCharacters:
      purpose === "thread"
        ? config.content.maxThreadCharacters
        : config.content.maxCommentCharacters,
  };

  const calls: CallRecord[] = [];
  const sample: EvalSample = {
    persona: persona.slug,
    purpose,
    effort,
    body: "",
    expectedScript,
    detectedScript: null,
    scriptOk: false,
    firstCodes: [],
    firstPass: false,
    repaired: false,
    finalCodes: [],
    finalPass: false,
    verdictReasons: [],
    dialect: "not_assessable",
    incomplete: false,
    calls,
  };

  const first = await runner.call<Awaited<ReturnType<ProviderSet["generation"]["generate"]>>>(
    effort,
    "generation",
    baseRequest,
  );
  calls.push(first.record);
  sample.incomplete = first.record.incomplete;
  if (!first.result) {
    sample.error = first.record.error ?? "generation failed";
    return sample;
  }

  let draft = first.result;
  const check = (d: typeof draft, seed: string) => {
    const input = gateInputFor(purpose, d, ctx, seed);
    return { input, free: runFreeChecks(input, config) };
  };
  let current = check(draft, `${tag}:c1`);
  sample.firstCodes = current.free.codes;
  sample.firstPass = current.free.blocking.length === 0;
  sample.detectedScript = current.free.script;

  if (!sample.firstPass) {
    sample.repaired = true;
    const repairRequest: GenerationRequest = {
      ...baseRequest,
      seed: `${tag}:r`,
      repair: {
        previousTitle: draft.title,
        previousBody: draft.body,
        codes: current.free.blocking,
      },
    };
    const repair = await runner.call<typeof draft>(effort, "generation", repairRequest);
    repair.record.purpose = "repair";
    calls.push(repair.record);
    sample.incomplete ||= repair.record.incomplete;
    if (repair.result) {
      draft = repair.result;
      current = check(draft, `${tag}:c2`);
      sample.detectedScript = current.free.script;
    }
  }
  sample.title = draft.title;
  sample.body = draft.body;
  sample.finalCodes = current.free.codes;
  sample.finalPass = current.free.blocking.length === 0;
  sample.scriptOk = current.free.script === expectedScript;
  sample.dialect = dialectAdherence(
    expectedDialect(persona.vocabularyNotes),
    detectDialect(`${draft.title ?? ""}\n${draft.body}`),
  );

  // Like the real pipeline, a draft that fails the free checks is never sent to the validator.
  if (sample.finalPass) {
    const input = current.input;
    const request: ValidationRequest = {
      kind: input.kind,
      title: input.title,
      body: input.body,
      context: input.context,
      heuristics: { language: current.free.language, topical: current.free.topical },
      evidence: input.evidence ?? [],
      claimedEvidenceIds: input.claimedEvidenceIds ?? [],
      seed: `${tag}:v`,
      maxOutputTokens: 1500,
    };
    const verdict = await runner.call<
      Awaited<ReturnType<ProviderSet["validation"]["validate"]>>
    >(effort, "validation", request);
    calls.push(verdict.record);
    sample.incomplete ||= verdict.record.incomplete;
    if (verdict.result) {
      sample.verdict = verdict.result.verdict;
      sample.verdictReasons = verdict.result.reasons;
    }
  }
  return sample;
}

async function runCorpus(
  runner: Runner,
  config: AgoraConfig,
  effort: ReasoningEffort,
  runId: string,
) {
  const results: CorpusResult[] = [];
  for (const [index, item] of VALIDATION_CORPUS.entries()) {
    const input: GateInput = {
      kind: item.kind,
      title: item.title,
      body: item.body,
      context: {
        communitySlug: item.communitySlug,
        communityName: item.communityName,
        inheritsTopic: item.kind === "comment",
      },
      seed: `eval:${runId}:corpus:${index}`,
    };
    const free = runFreeChecks(input, config);
    const request: ValidationRequest = {
      kind: item.kind,
      title: item.title,
      body: item.body,
      context: input.context,
      heuristics: { language: free.language, topical: free.topical },
      evidence: [],
      claimedEvidenceIds: [],
      seed: input.seed,
      maxOutputTokens: 1500,
    };
    const out = await runner.call<Awaited<ReturnType<ProviderSet["validation"]["validate"]>>>(
      effort,
      "validation",
      request,
    );
    results.push({
      id: item.id,
      category: item.category,
      expected: item.expected,
      verdict: out.result?.verdict ?? "error",
      reasons: out.result?.reasons ?? [],
      costUsd: out.record.costUsd,
    });
  }
  return results;
}

const pct = (v: number) => `${(v * 100).toFixed(1)} %`;
const usd = (v: number) => `USD ${v.toFixed(4)}`;

function printSummary(
  summaries: EffortSummary[],
  corpus: CorpusSummary | null,
  corpusEffort: string,
  totalUsd: number,
  stopped: string | null,
  dryRun: boolean,
): void {
  const out: string[] = [];
  out.push(
    dryRun
      ? "== Serbian evaluation (DRY RUN, mock providers, no network) =="
      : "== Serbian evaluation ==",
  );
  for (const s of summaries) {
    out.push("", `-- effort ${s.effort}: ${s.samples} samples, ${s.callCount} calls --`);
    out.push(
      `INCOMPLETE responses: ${s.incompleteCount}  (failed generations: ${s.failedGenerations})`,
    );
    out.push(
      `free checks first pass ${pct(s.firstPassRate)}, after repair ${pct(s.afterRepairRate)}`,
    );
    out.push(`script adherence ${pct(s.scriptRate)}`);
    out.push(
      `dialect adherence ${s.dialectAssessable ? pct(s.dialectMatch / s.dialectAssessable) : "n/a"} (${s.dialectMatch}/${s.dialectAssessable} recognisable)`,
    );
    out.push(`validator verdicts on drafts: ${JSON.stringify(s.verdicts)}`);
    for (const p of ["thread", "reply"] as const) {
      const t = s.tokensByPurpose[p];
      out.push(
        `${p} generation (${t.calls} calls): avg input ${t.input.toFixed(0)} (cached ${t.cached.toFixed(0)}), output ${t.output.toFixed(0)}, reasoning ${t.reasoning.toFixed(0)}`,
      );
    }
    out.push(
      `cost: avg ${usd(s.averageCostPerCallUsd)} per call, total ${usd(s.totalCostUsd)}`,
    );
  }
  if (corpus) {
    out.push("", `-- validator corpus at effort ${corpusEffort}: ${corpus.total} samples --`);
    out.push(`agreement ${pct(corpus.agreement)}`);
    out.push(
      `false passes (${corpus.falsePasses.length}): ${corpus.falsePasses.join(", ") || "none"}`,
    );
    out.push(
      `false rejects (${corpus.falseRejects.length}): ${corpus.falseRejects.join(", ") || "none"}`,
    );
    out.push(`corpus cost ${usd(corpus.totalCostUsd)}`);
  }
  out.push("", `run total ${usd(totalUsd)}`);
  if (stopped) out.push(`STOPPED EARLY: ${stopped}`);
  out.push("", "== Adoption bar ==");
  for (const s of summaries) {
    for (const line of evaluateBar(s, corpus)) {
      out.push(`[effort ${s.effort}] ${line.pass ? "PASS" : "FAIL"}  ${line.label}`);
    }
  }
  out.push("NOTE  needs human reading of samples");
  console.log(out.join("\n"));
}

async function main(): Promise<void> {
  loadDotEnv();
  const opts = parseArgs(process.argv.slice(2));
  const env = getEnv();

  if (!opts.dryRun && !env.OPENAI_API_KEY) {
    console.error(
      "OPENAI_API_KEY nije podešen; evaluacija se ne pokreće. Dodajte ključ u .env ili koristite --dry-run.\n" +
        "OPENAI_API_KEY is not set, so the evaluation will not start. Add it to .env or use --dry-run.",
    );
    process.exitCode = 1;
    return;
  }

  const handle = createDb(env.DATABASE_URL, { max: 4 });
  try {
    const db = handle.db;
    const config = await getActiveConfig(db);
    const gateway = new CostGateway({ db, config, clock: systemClock });
    const cache = new Map<string, ProviderSet>();
    const providersFor = (effort: ReasoningEffort): ProviderSet => {
      let set = cache.get(effort);
      if (!set) {
        const raw = opts.dryRun
          ? createProviders("mock")
          : createProviders("live", {
              openaiApiKey: env.OPENAI_API_KEY,
              reasoningEffort: effort,
            });
        set = meterProviders(raw, gateway, "eval");
        cache.set(effort, set);
      }
      return set;
    };

    const runner = new Runner(Math.round(opts.maxUsd * 1e6), providersFor);
    const runId = Date.now().toString(36);
    const all = await loadPersonaInputs(db, opts.personas);
    if (all.length === 0)
      throw new Error("No seeded personas with a home community. Run npm run db:seed.");
    const samples: EvalSample[] = [];
    const now = new Date();

    try {
      for (const [index, effort] of opts.efforts.entries()) {
        const group = index === 0 ? all : all.slice(0, 6);
        for (const persona of group) {
          for (const purpose of ["thread", "reply"] as const) {
            const sample = await runSample(
              runner,
              db,
              config,
              persona,
              purpose,
              effort,
              runId,
              now,
            );
            if (sample) samples.push(sample);
          }
        }
      }
    } catch (error) {
      if (!(error instanceof StopRun)) throw error;
    }

    let corpusResults: CorpusResult[] = [];
    const corpusEffort: ReasoningEffort = opts.efforts.includes(
      env.AGORA_OPENAI_REASONING_EFFORT,
    )
      ? env.AGORA_OPENAI_REASONING_EFFORT
      : (opts.efforts[0] ?? "low");
    if (!runner.stoppedReason) {
      try {
        corpusResults = await runCorpus(runner, config, corpusEffort, runId);
      } catch (error) {
        if (!(error instanceof StopRun)) throw error;
      }
    }

    const summaries = opts.efforts.map((e) => summarizeEffort(e, samples));
    const corpus = corpusResults.length ? summarizeCorpus(corpusResults) : null;
    const totalUsd = runner.spentMicros / 1e6;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join("eval-reports", `serbian-${stamp}.json`);
    mkdirSync("eval-reports", { recursive: true });
    writeFileSync(
      file,
      JSON.stringify(
        {
          dryRun: opts.dryRun,
          options: opts,
          stopped: runner.stoppedReason,
          totalUsd,
          summaries,
          corpus,
          corpusResults,
          samples,
        },
        null,
        2,
      ),
    );
    printSummary(summaries, corpus, corpusEffort, totalUsd, runner.stoppedReason, opts.dryRun);
    console.log(`
Full report: ${file}`);
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
