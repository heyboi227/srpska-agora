import { describe, expect, it } from "vitest";
import { getPreset, QUIET_PRESET, STANDARD_PRESET } from "@/lib/config/presets";
import { DEFAULT_SCHEDULER_CONFIG, safeParseConfig } from "@/lib/config/schema";

describe("configuration presets", () => {
  it("standard preset matches the pilot policy", () => {
    expect(STANDARD_PRESET.content.maxNewThreadsPerDay).toBe(12);
    expect(STANDARD_PRESET.content.maxNewCommentsPerDay).toBe(120);
    expect(STANDARD_PRESET.content.maxRevisionsPerDay).toBe(12);
    expect(STANDARD_PRESET.content.maxSummariesPerDay).toBe(6);
    const contentActions =
      STANDARD_PRESET.content.maxNewThreadsPerDay +
      STANDARD_PRESET.content.maxNewCommentsPerDay +
      STANDARD_PRESET.content.maxRevisionsPerDay +
      STANDARD_PRESET.content.maxSummariesPerDay;
    expect(contentActions).toBe(150);
    expect(STANDARD_PRESET.budget.monthlyVariableSpendLimit).toBe(15);
    expect(STANDARD_PRESET.budget.dailyVariableSpendLimit).toBe(0.5);
    expect(STANDARD_PRESET.news.maxPaidSearchCallsPerDay).toBe(8);
  });

  it("quiet preset sits at the lower end of the budget", () => {
    expect(QUIET_PRESET.content.maxNewThreadsPerDay).toBe(5);
    expect(QUIET_PRESET.content.maxNewCommentsPerDay).toBe(48);
    expect(QUIET_PRESET.budget.monthlyVariableSpendLimit).toBe(7);
    expect(QUIET_PRESET.budget.dailyVariableSpendLimit).toBe(0.23);
    expect(QUIET_PRESET.news.maxPaidSearchCallsPerDay).toBe(4);
  });

  it("getPreset returns an independent copy", () => {
    const a = getPreset("standard");
    a.content.maxNewThreadsPerDay = 1;
    expect(STANDARD_PRESET.content.maxNewThreadsPerDay).toBe(12);
  });

  it("rejects out-of-bounds values and inconsistent thresholds", () => {
    const tooMany = structuredClone(STANDARD_PRESET);
    tooMany.content.maxNewCommentsPerDay = 5000;
    expect(safeParseConfig(tooMany).success).toBe(false);

    const dailyAboveMonthly = structuredClone(STANDARD_PRESET);
    dailyAboveMonthly.budget.dailyVariableSpendLimit = 4;
    dailyAboveMonthly.budget.monthlyVariableSpendLimit = 3;
    expect(safeParseConfig(dailyAboveMonthly).success).toBe(false);

    const badDisk = structuredClone(STANDARD_PRESET);
    badDisk.storage.diskPauseGrowthUsedPercent = 60;
    expect(safeParseConfig(badDisk).success).toBe(false);

    const wrongParticipation = structuredClone(STANDARD_PRESET) as unknown as {
      product: { participation: string };
    };
    wrongParticipation.product.participation = "humans_too";
    expect(safeParseConfig(wrongParticipation).success).toBe(false);
  });

  it("fills scheduler defaults for revisions stored without the section", () => {
    const legacy = structuredClone(STANDARD_PRESET) as unknown as Record<string, unknown>;
    delete legacy.scheduler;
    const parsed = safeParseConfig(legacy);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.scheduler).toEqual(DEFAULT_SCHEDULER_CONFIG);
  });

  it("rejects out-of-range scheduler values", () => {
    const bad = structuredClone(STANDARD_PRESET);
    bad.scheduler.maxActionsPerTick = 11;
    expect(safeParseConfig(bad).success).toBe(false);
  });

  it("both presets contain the scheduler section", () => {
    expect(STANDARD_PRESET.scheduler).toEqual(DEFAULT_SCHEDULER_CONFIG);
    expect(QUIET_PRESET.scheduler).toEqual(DEFAULT_SCHEDULER_CONFIG);
  });
});
