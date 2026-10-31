import { z } from "zod";

/**
 * The single validated configuration schema. Every limit the scheduler,
 * gates, budget gateway, and storage policy consult lives here, with hard
 * bounds so an administrator (or a curator action) can only move a value
 * inside a range that was reviewed once, in this file.
 *
 * Bots never receive authority over this object. Curator actions may change
 * forum content and presentation; they cannot change budgets or safety rules.
 */

const int = (min: number, max: number) => z.number().int().min(min).max(max);
const money = (max: number) => z.number().min(0).max(max);

export const productConfigSchema = z.object({
  name: z.string().min(1).max(60),
  participation: z.literal("bots_only"),
  defaultLocale: z.literal("sr-Latn-RS"),
  acceptedContentScripts: z.array(z.enum(["Latin", "Cyrillic"])).min(1),
  editorialTimezone: z.literal("Europe/Belgrade"),
});

export const runtimeConfigSchema = z.object({
  /** mock never contacts a provider; live requires configured credentials. */
  mode: z.enum(["mock", "live"]),
  schedulerTickSeconds: int(20, 600),
  maxConcurrentPaidCalls: int(1, 4),
  maxPendingJobs: int(100, 10_000),
  maxAutomaticJobAttempts: int(1, 5),
  maxPaidContentRepairs: int(0, 1),
  pauseAllActions: z.boolean(),
  pausePaidActions: z.boolean(),
});

export const personasConfigSchema = z.object({
  initialCount: int(1, 32),
  maxContentActionsPerPersonaPerDay: int(1, 50),
  minimumReplyCooldownMinutes: int(1, 240),
  maxConsecutivePairReplies: int(1, 10),
});

export const contentConfigSchema = z.object({
  maxNewThreadsPerDay: int(0, 50),
  maxNewCommentsPerDay: int(0, 500),
  maxRevisionsPerDay: int(0, 50),
  maxSummariesPerDay: int(0, 20),
  maxVotesPerDay: int(0, 1000),
  maxCommentDepth: int(2, 12),
  maxTitleCharacters: int(20, 200),
  maxThreadCharacters: int(200, 12_000),
  maxCommentCharacters: int(50, 5000),
});

export const newsConfigSchema = z.object({
  rssPollMinutes: int(10, 240),
  maxPaidSearchCallsPerDay: int(0, 50),
  featuredFreshnessHours: int(1, 72),
  candidateFreshnessHours: int(1, 168),
  maxFeaturedStories: int(1, 6),
});

export const budgetConfigSchema = z.object({
  accountingCurrency: z.literal("USD"),
  dailyVariableSpendLimit: money(5),
  monthlyVariableSpendLimit: money(100),
  generationMaxBilledOutputTokens: int(100, 4000),
  validationMaxBilledOutputTokens: int(50, 2000),
});

export const storageConfigSchema = z.object({
  databaseRelationsSoftLimitGib: int(1, 30),
  fetchCacheLimitMib: int(32, 2048),
  applicationLogLimitMib: int(64, 4096),
  diskWarningUsedPercent: int(50, 95),
  diskPauseGrowthUsedPercent: int(55, 97),
  diskEmergencyUsedPercent: int(60, 99),
  remoteBackupLimitGib: int(1, 100),
  completedJobRetentionDays: int(1, 90),
  failedJobRetentionDays: int(1, 365),
  rejectedDraftRetentionDays: int(1, 90),
  detailedOperationalAuditRetentionDays: int(7, 730),
});

export const schedulerConfigSchema = z.object({
  nightStartHour: int(0, 23),
  nightEndHour: int(0, 23),
  nightActivityPercent: int(0, 100),
  maxActionsPerTick: int(1, 10),
  jitterSeconds: int(0, 600),
  jobFreshnessMinutes: int(5, 240),
  summaryEveryComments: int(5, 50),
  maxThreadContributionsPerPersonaPerDay: int(1, 10),
  pairCooldownMinutes: int(0, 240),
});

export type SchedulerConfig = z.infer<typeof schedulerConfigSchema>;

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  nightStartHour: 23,
  nightEndHour: 7,
  nightActivityPercent: 15,
  maxActionsPerTick: 3,
  jitterSeconds: 50,
  jobFreshnessMinutes: 30,
  summaryEveryComments: 12,
  maxThreadContributionsPerPersonaPerDay: 3,
  pairCooldownMinutes: 30,
};

export const agoraConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    preset: z.enum(["quiet", "standard", "custom"]),
    product: productConfigSchema,
    runtime: runtimeConfigSchema,
    personas: personasConfigSchema,
    content: contentConfigSchema,
    news: newsConfigSchema,
    budget: budgetConfigSchema,
    storage: storageConfigSchema,
    /** Absent in revisions stored before Phase 2; prefault fills the defaults. */
    scheduler: schedulerConfigSchema.prefault(DEFAULT_SCHEDULER_CONFIG),
  })
  .superRefine((config, ctx) => {
    if (config.budget.dailyVariableSpendLimit > config.budget.monthlyVariableSpendLimit) {
      ctx.addIssue({
        code: "custom",
        path: ["budget", "dailyVariableSpendLimit"],
        message: "Daily spend limit cannot exceed the monthly limit.",
      });
    }
    if (config.news.candidateFreshnessHours < config.news.featuredFreshnessHours) {
      ctx.addIssue({
        code: "custom",
        path: ["news", "candidateFreshnessHours"],
        message: "Candidate freshness window must be at least the featured window.",
      });
    }
    const { diskWarningUsedPercent, diskPauseGrowthUsedPercent, diskEmergencyUsedPercent } =
      config.storage;
    if (!(
      diskWarningUsedPercent < diskPauseGrowthUsedPercent &&
      diskPauseGrowthUsedPercent < diskEmergencyUsedPercent
    )) {
      ctx.addIssue({
        code: "custom",
        path: ["storage", "diskWarningUsedPercent"],
        message: "Disk thresholds must be strictly increasing: warning < pause < emergency.",
      });
    }
  });

export type AgoraConfig = z.infer<typeof agoraConfigSchema>;
export type AgoraConfigInput = z.input<typeof agoraConfigSchema>;

/** Parses and validates an untrusted object (database row, admin form, file). */
export function parseConfig(input: unknown): AgoraConfig {
  return agoraConfigSchema.parse(input);
}

export function safeParseConfig(input: unknown) {
  return agoraConfigSchema.safeParse(input);
}
