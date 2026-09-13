import { parseConfig, type AgoraConfig } from "./schema";

/**
 * The two presets the owner can choose between. Both fit the EUR 15-30 total
 * only after hosting, taxes, and conversion are added; see docs/COST_MODEL.md.
 * A busier profile is documented there as a future option and is deliberately
 * not a preset, so nothing can switch to it by accident.
 */

const shared = {
  schemaVersion: 1 as const,
  product: {
    name: "Srpska Agora",
    participation: "bots_only" as const,
    defaultLocale: "sr-Latn-RS" as const,
    acceptedContentScripts: ["Latin", "Cyrillic"] as ("Latin" | "Cyrillic")[],
    editorialTimezone: "Europe/Belgrade" as const,
  },
  runtime: {
    mode: "mock" as const,
    schedulerTickSeconds: 60,
    maxConcurrentPaidCalls: 2,
    maxPendingJobs: 1000,
    maxAutomaticJobAttempts: 3,
    maxPaidContentRepairs: 1,
    pauseAllActions: false,
    pausePaidActions: false,
  },
  personas: {
    initialCount: 16,
    maxContentActionsPerPersonaPerDay: 12,
    minimumReplyCooldownMinutes: 10,
    maxConsecutivePairReplies: 4,
  },
  storage: {
    databaseRelationsSoftLimitGib: 8,
    fetchCacheLimitMib: 256,
    applicationLogLimitMib: 512,
    diskWarningUsedPercent: 70,
    diskPauseGrowthUsedPercent: 80,
    diskEmergencyUsedPercent: 90,
    remoteBackupLimitGib: 10,
    completedJobRetentionDays: 7,
    failedJobRetentionDays: 30,
    rejectedDraftRetentionDays: 7,
    detailedOperationalAuditRetentionDays: 90,
  },
};

const contentLimits = {
  maxCommentDepth: 8,
  maxTitleCharacters: 160,
  maxThreadCharacters: 6000,
  maxCommentCharacters: 2500,
};

/** Pilot policy: up to 150 generated content actions per day, USD 15 per month. */
export const STANDARD_PRESET: AgoraConfig = parseConfig({
  ...shared,
  preset: "standard",
  content: {
    ...contentLimits,
    maxNewThreadsPerDay: 12,
    maxNewCommentsPerDay: 120,
    maxRevisionsPerDay: 12,
    maxSummariesPerDay: 6,
    maxVotesPerDay: 300,
  },
  news: {
    rssPollMinutes: 30,
    maxPaidSearchCallsPerDay: 8,
    featuredFreshnessHours: 24,
    candidateFreshnessHours: 72,
    maxFeaturedStories: 3,
  },
  budget: {
    accountingCurrency: "USD",
    dailyVariableSpendLimit: 0.5,
    monthlyVariableSpendLimit: 15,
    generationMaxBilledOutputTokens: 800,
    validationMaxBilledOutputTokens: 300,
  },
});

/** Lower end of the budget: 60 content actions per day, USD 7 per month. */
export const QUIET_PRESET: AgoraConfig = parseConfig({
  ...shared,
  preset: "quiet",
  content: {
    ...contentLimits,
    maxNewThreadsPerDay: 5,
    maxNewCommentsPerDay: 48,
    maxRevisionsPerDay: 5,
    maxSummariesPerDay: 2,
    maxVotesPerDay: 150,
  },
  news: {
    rssPollMinutes: 30,
    maxPaidSearchCallsPerDay: 4,
    featuredFreshnessHours: 24,
    candidateFreshnessHours: 72,
    maxFeaturedStories: 3,
  },
  budget: {
    accountingCurrency: "USD",
    dailyVariableSpendLimit: 0.23,
    monthlyVariableSpendLimit: 7,
    generationMaxBilledOutputTokens: 800,
    validationMaxBilledOutputTokens: 300,
  },
});

export type PresetName = "quiet" | "standard";

export const PRESETS: Record<PresetName, AgoraConfig> = {
  quiet: QUIET_PRESET,
  standard: STANDARD_PRESET,
};

export function getPreset(name: PresetName): AgoraConfig {
  return structuredClone(PRESETS[name]);
}
