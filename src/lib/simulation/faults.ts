import { SeededRandom } from "@/lib/random";
import {
  ProviderCallError,
  type GenerationRequest,
  type GenerationResult,
  type TextGenerationProvider,
} from "@/lib/providers/types";

export interface FaultRates {
  /** Chance that a call fails before the provider did any work (retryable, not billed). */
  transientRate: number;
  /** Chance that a call times out with an unknown outcome (retryable, counted as spent). */
  ambiguousRate: number;
  /**
   * Chance that the first generation for a thread, reply or revision action is an
   * English draft (it fails the free language check, so the job repairs it). For a
   * third of those the repair is English too, so the draft is quarantined. Default 0.
   */
  badDraftRate?: number;
}

export const DEFAULT_BAD_DRAFT_RATE = 0.04;
const REPAIRABLE = new Set(["thread", "reply", "revision"]);
/** Share of bad drafts whose repair is bad as well. */
const BAD_REPAIR_SHARE = 1 / 3;

const ENGLISH_BODY =
  "This is a perfectly ordinary English paragraph about keeping the pepper spread in a dark cellar all winter long, and nothing in it is written in Serbian.";
const ENGLISH_TITLE = "Where do you keep the pepper spread over the winter?";

/** Whether the first draft for this action key is bad, and whether its repair is bad too. Pure in seed and key. */
export function decideBadDraft(
  seed: string,
  rates: FaultRates,
  actionKey: string,
): { bad: boolean; badRepair: boolean } {
  const rate = rates.badDraftRate ?? 0;
  if (rate <= 0) return { bad: false, badRepair: false };
  const bad = new SeededRandom(`${seed}|bad-draft|${actionKey}`).next() < rate;
  if (!bad) return { bad: false, badRepair: false };
  const badRepair =
    new SeededRandom(`${seed}|bad-repair|${actionKey}`).next() < BAD_REPAIR_SHARE;
  return { bad, badRepair };
}

export type FaultKind = "transient" | "ambiguous" | "permanent";

/**
 * Decides what happens to one provider call. The draw depends only on the seed,
 * the action key and how many calls that key has made, so a run repeats exactly
 * and a retry gets a fresh draw. Scripted permanent failures fail every call.
 */
export function decideFault(
  seed: string,
  rates: FaultRates,
  actionKey: string,
  callIndex: number,
  permanent: ReadonlySet<string>,
): FaultKind | null {
  if (permanent.has(actionKey)) return "permanent";
  const draw = new SeededRandom(`${seed}|${actionKey}|${callIndex}`).next();
  if (draw < rates.transientRate) return "transient";
  if (draw < rates.transientRate + rates.ambiguousRate) return "ambiguous";
  return null;
}

export interface FaultTally {
  calls: number;
  transient: number;
  ambiguous: number;
  permanent: number;
  /** First drafts replaced by an English one. */
  badDrafts: number;
  /** Repairs that came back English as well. */
  badRepairs: number;
}

/** Shared by every provider the simulation builds, so call counts survive across jobs. */
export class FaultInjector {
  private readonly calls = new Map<string, number>();
  private readonly permanent = new Set<string>();
  readonly tally: FaultTally = {
    calls: 0,
    transient: 0,
    ambiguous: 0,
    permanent: 0,
    badDrafts: 0,
    badRepairs: 0,
  };
  /** Action keys whose bad first draft was already counted, so a retried generation counts once. */
  private readonly badSeen = new Set<string>();

  constructor(
    private readonly seed: string,
    private readonly rates: FaultRates,
  ) {}

  /** Every generation call under this action key fails from now on. */
  failPermanently(actionKey: string): void {
    this.permanent.add(actionKey);
  }

  get scriptedFailures(): readonly string[] {
    return [...this.permanent];
  }

  wrap(inner: TextGenerationProvider): TextGenerationProvider {
    return {
      name: inner.name,
      model: inner.model,
      configured: inner.configured,
      generate: async (
        request: GenerationRequest,
        signal?: AbortSignal,
      ): Promise<GenerationResult> => {
        const index = this.calls.get(request.seed) ?? 0;
        this.calls.set(request.seed, index + 1);
        this.tally.calls += 1;
        const fault = decideFault(this.seed, this.rates, request.seed, index, this.permanent);
        if (fault === "ambiguous") {
          this.tally.ambiguous += 1;
          throw new ProviderCallError("simulated timeout, outcome unknown", "ambiguous", true, {
            code: "timeout",
          });
        }
        if (fault === "transient") {
          this.tally.transient += 1;
          throw new ProviderCallError("simulated provider error 503", "not_billed", true, {
            status: 503,
          });
        }
        if (fault === "permanent") {
          this.tally.permanent += 1;
          throw new ProviderCallError("simulated persistent outage", "not_billed", true, {
            status: 503,
          });
        }
        const result = await inner.generate(request, signal);
        // Summaries have no repair step, so only content the job repairs is spoiled.
        if (!REPAIRABLE.has(request.purpose)) return result;
        const draft = decideBadDraft(this.seed, this.rates, request.seed);
        const english = request.repair ? draft.bad && draft.badRepair : draft.bad;
        if (!english) return result;
        if (request.repair) this.tally.badRepairs += 1;
        else if (!this.badSeen.has(request.seed)) {
          this.badSeen.add(request.seed);
          this.tally.badDrafts += 1;
        }
        return {
          ...result,
          title: result.title === undefined ? undefined : ENGLISH_TITLE,
          body: ENGLISH_BODY,
          script: "Latin",
        };
      },
    };
  }
}
