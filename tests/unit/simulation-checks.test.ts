import { describe, expect, it } from "vitest";
import {
  alternatingChainLength,
  averageCount,
  burstBound,
  evaluateChecks,
  groupCount,
  hourBins,
  topShare,
  violationsOf,
  type ContentFact,
  type DecisionFact,
  type EvalInput,
  type HourBin,
} from "@/lib/simulation/checks";
import { defaultScenario } from "@/lib/simulation/scenario";

type Node = Pick<ContentFact, "authorId" | "parentId">;

const chain = (authors: string[]): Map<string, Node> => {
  // authors[0] is the top-level comment; each next one replies to the previous.
  const map = new Map<string, Node>();
  authors.forEach((authorId, i) => {
    map.set(`c${i}`, { authorId, parentId: i === 0 ? null : `c${i - 1}` });
  });
  return map;
};

describe("alternatingChainLength", () => {
  it("counts a top-level comment as one", () => {
    expect(alternatingChainLength("c0", chain(["a"]))).toBe(1);
  });

  it("counts A, B, A, B from the newest comment", () => {
    const map = chain(["a", "b", "a", "b"]);
    expect(alternatingChainLength("c3", map)).toBe(4);
    expect(alternatingChainLength("c2", map)).toBe(3);
  });

  it("stops where a third author or a repeat breaks the pattern", () => {
    expect(alternatingChainLength("c3", chain(["x", "a", "c", "b"]))).toBe(2);
    expect(alternatingChainLength("c2", chain(["a", "a", "b"]))).toBe(2);
    expect(alternatingChainLength("c1", chain(["a", "a"]))).toBe(1);
  });

  it("is zero for an unknown comment", () => {
    expect(alternatingChainLength("nope", chain(["a"]))).toBe(0);
  });
});

describe("share maths", () => {
  it("groups and finds the top share", () => {
    const counts = groupCount(["x", "x", "y", "z"], (v) => v);
    expect(counts.get("x")).toBe(2);
    expect(topShare(counts)).toBe(0.5);
    expect(topShare(new Map())).toBe(0);
  });

  it("averages only eligible hour bins", () => {
    const bin = (count: number, eligible: boolean): HourBin => ({
      start: new Date(0),
      belgradeHour: 0,
      count,
      eligible,
    });
    expect(averageCount([bin(10, true), bin(20, true), bin(999, false)])).toBe(15);
    expect(averageCount([bin(5, false)])).toBeNull();
  });
});

describe("burstBound", () => {
  it("is larger by day than by night and always positive", () => {
    const scenario = defaultScenario();
    expect(burstBound(scenario, 12)).toBeGreaterThan(burstBound(scenario, 2));
    expect(burstBound(scenario, 2)).toBeGreaterThan(0);
  });
});

function emptyInput(): EvalInput {
  const scenario = defaultScenario({ hours: 4 });
  return {
    scenario: {
      ...scenario,
      faults: { ...scenario.faults, badDraftRate: 0 },
      workerOutage: null,
      forumPause: null,
      lowerDailyLimit: null,
      duplicateDeliveryHour: null,
      scriptedFailureHour: null,
    },
    end: new Date(scenario.start.getTime() + 4 * 3_600_000),
    personas: [
      { id: "p1", name: "Prva", maxContentActionsPerDay: 5, replyCooldownMinutes: 10 },
      { id: "p2", name: "Druga", maxContentActionsPerDay: 5, replyCooldownMinutes: 10 },
    ],
    communityCount: 10,
    decisions: [],
    content: [],
    runs: [],
    periods: [],
    rowsCreatedInPause: 0,
    pauseWindow: null,
    outageWindow: null,
    queue: { maxPending: 3, deadLetters: 0, retries: 0 },
    scriptedFailures: 0,
    duplicate: null,
    cleanup: { runs: {}, totals: {}, maxMemoriesAfterCleanup: [] },
    retention: {
      expiredSessionsLeft: 0,
      validSessionsLeft: 2,
      oldLoginAttemptsLeft: 0,
      expiredMemoriesLeft: 0,
    },
    duplicateActionKeys: 0,
    publishedThreadsNew: 0,
    publishedCommentsNew: 0,
    repairCalls: 0,
    repairKeys: 0,
    repairKeysOverLimit: 0,
    quarantinedDecisions: 0,
    quarantinedWithContent: 0,
  };
}

const decision = (over: Partial<DecisionFact>): DecisionFact => ({
  id: crypto.randomUUID(),
  kind: "reply",
  personaId: "p1",
  threadId: "t1",
  outcome: "published",
  code: null,
  createdAt: new Date("2026-11-02T08:00:00Z"),
  completedAt: new Date("2026-11-02T08:00:30Z"),
  ...over,
});

const find = (input: EvalInput, id: number) =>
  evaluateChecks(input).find((c) => c.id === id) ?? { status: "missing" };

describe("evaluateChecks", () => {
  it("passes an empty run and marks the checks it cannot judge", () => {
    const checks = evaluateChecks(emptyInput());
    expect(violationsOf(checks)).toEqual([]);
    expect(checks.find((c) => c.id === 8)?.status).toBe("not_evaluated");
    expect(checks.find((c) => c.id === 11)?.status).toBe("not_evaluated");
  });

  it("flags a Belgrade day over the persona limit and over the global maximum", () => {
    const input = emptyInput();
    input.decisions = Array.from({ length: 6 }, () => decision({}));
    expect(find(input, 2).status).toBe("fail");
    input.scenario.config.content.maxNewCommentsPerDay = 5;
    expect(find(input, 1).status).toBe("fail");
  });

  it("counts quarantined decisions against the maximum but not skipped ones", () => {
    const input = emptyInput();
    input.scenario.config.content.maxNewCommentsPerDay = 2;
    input.decisions = [
      decision({ personaId: "p1" }),
      decision({ personaId: "p2", outcome: "quarantined" }),
      decision({ personaId: "p1", outcome: "skipped", code: "stale" }),
    ];
    expect(find(input, 1).status).toBe("pass");
    input.decisions.push(decision({ personaId: "p2" }));
    expect(find(input, 1).status).toBe("fail");
  });

  it("flags two posts closer than the cooldown", () => {
    const input = emptyInput();
    const post = (id: string, iso: string): ContentFact => ({
      id,
      isThread: false,
      threadId: "t1",
      parentId: null,
      authorId: "p1",
      communityId: null,
      createdAt: new Date(iso),
    });
    input.content = [post("a", "2026-11-02T08:00:00Z"), post("b", "2026-11-02T08:05:00Z")];
    expect(find(input, 3).status).toBe("fail");
    input.content = [post("a", "2026-11-02T08:00:00Z"), post("b", "2026-11-02T08:20:00Z")];
    expect(find(input, 3).status).toBe("pass");
  });

  it("flags a pair chain beyond the limit", () => {
    const input = emptyInput();
    const authors = ["p1", "p2", "p1", "p2", "p1"];
    input.content = authors.map((authorId, i) => ({
      id: `c${i}`,
      isThread: false,
      threadId: "t1",
      parentId: i === 0 ? null : `c${i - 1}`,
      authorId,
      communityId: null,
      createdAt: new Date(`2026-11-02T0${i}:00:00Z`),
    }));
    expect(find(input, 4).status).toBe("fail");
  });

  it("flags more thread contributions in a day than the cap", () => {
    const input = emptyInput();
    input.decisions = Array.from({ length: 4 }, () => decision({}));
    expect(find(input, 5).status).toBe("fail");
  });

  it("flags spending above a limit and a recorded limit above the highest the scenario sets", () => {
    const input = emptyInput();
    const start = new Date("2026-11-02T00:00:00Z");
    input.periods = [
      {
        kind: "day",
        start,
        limitMicros: 500_000,
        spentMicros: 400_000,
        reservedMicros: 50_000,
      },
    ];
    expect(find(input, 9).status).toBe("pass");
    input.periods[0] = {
      kind: "day",
      start,
      limitMicros: 500_000,
      spentMicros: 400_000,
      reservedMicros: 150_000,
    };
    expect(find(input, 9).status).toBe("fail");
    input.periods[0] = {
      kind: "day",
      start,
      limitMicros: 600_000,
      spentMicros: 100_000,
      reservedMicros: 0,
    };
    expect(find(input, 9).status).toBe("fail");
  });

  it("requires the three degraded stages in order on the lowered day", () => {
    const input = emptyInput();
    input.scenario.hours = 48;
    input.scenario.lowerDailyLimit = { fromHour: 20, limitUsd: 0.06 };
    input.end = new Date(input.scenario.start.getTime() + 48 * 3_600_000);
    const run = (hour: number, stage: "normal" | "reduced" | "minimal" | "paused") => ({
      tickAt: new Date(input.scenario.start.getTime() + hour * 3_600_000),
      state: "planned",
      stage,
    });
    input.runs = [run(20, "normal"), run(22, "reduced"), run(30, "minimal"), run(40, "paused")];
    expect(find(input, 10).status).toBe("pass");
    input.runs = [run(20, "normal"), run(22, "minimal"), run(30, "reduced"), run(40, "paused")];
    expect(find(input, 10).status).toBe("fail");
    input.runs = [run(20, "normal"), run(22, "reduced"), run(40, "paused")];
    expect(find(input, 10).status).toBe("fail");
  });

  it("compares night and day rates only over undistorted hours", () => {
    const input = emptyInput();
    input.scenario.hours = 4;
    // 04:00Z is 05:00 in Belgrade: hours 0 and 1 are night (05, 06), hours 2 and 3 are day.
    const hourStart = (h: number) => new Date(input.scenario.start.getTime() + h * 3_600_000);
    input.runs = [0, 1, 2, 3].map((h) => ({
      tickAt: hourStart(h),
      state: "planned",
      stage: "normal",
    }));
    const planned = (hour: number, n: number) =>
      Array.from({ length: n }, () =>
        decision({ createdAt: new Date(hourStart(hour).getTime() + 60_000) }),
      );
    input.decisions = [
      ...planned(0, 1),
      ...planned(1, 1),
      ...planned(2, 10),
      ...planned(3, 10),
    ];
    expect(hourBins(input).map((b) => b.eligible)).toEqual([true, true, true, true]);
    expect(find(input, 6).status).toBe("pass");
    input.decisions = [
      ...planned(0, 8),
      ...planned(1, 8),
      ...planned(2, 10),
      ...planned(3, 10),
    ];
    expect(find(input, 6).status).toBe("fail");
    // A degraded hour is left out of both averages.
    input.runs[3] = { tickAt: hourStart(3), state: "planned", stage: "reduced" };
    expect(hourBins(input).map((b) => b.eligible)).toEqual([true, true, true, false]);
  });

  it("holds the pause to what really happened inside its window", () => {
    const input = emptyInput();
    const from = new Date("2026-11-02T05:00:00Z");
    const to = new Date("2026-11-02T06:00:00Z");
    input.end = new Date("2026-11-02T08:00:00Z");
    input.pauseWindow = { from, to };
    const inside = (over: Partial<DecisionFact>) =>
      decision({ completedAt: new Date("2026-11-02T05:10:00Z"), ...over });
    input.decisions = [inside({ outcome: "skipped", code: "paused" })];
    expect(find(input, 8).status).toBe("pass");
    input.decisions = [inside({ outcome: "published" })];
    expect(find(input, 8).status).toBe("fail");
    input.decisions = [inside({ outcome: "skipped", code: "stale" })];
    expect(find(input, 8).status).toBe("fail");
    input.decisions = [];
    input.rowsCreatedInPause = 1;
    expect(find(input, 8).status).toBe("fail");
  });

  it("bounds the hour after an outage", () => {
    const input = emptyInput();
    input.scenario.hours = 4;
    input.outageWindow = {
      from: new Date("2026-11-02T04:00:00Z"),
      to: new Date("2026-11-02T05:00:00Z"),
    };
    const burst = burstBound(input.scenario, 6);
    const planned = (n: number) =>
      Array.from({ length: n }, () =>
        decision({ createdAt: new Date("2026-11-02T05:20:00Z") }),
      );
    input.decisions = planned(burst);
    expect(find(input, 7).status).toBe("pass");
    input.decisions = planned(burst + 1);
    expect(find(input, 7).status).toBe("fail");
  });

  it("flags decisions still queued, missing dead letters and a duplicate that changed anything", () => {
    const input = emptyInput();
    input.decisions = [decision({ outcome: "queued", completedAt: null })];
    input.scriptedFailures = 1;
    expect(find(input, 12).status).toBe("fail");

    const dupInput = emptyInput();
    dupInput.scenario.duplicateDeliveryHour = 10;
    expect(find(dupInput, 13).status).toBe("fail"); // never happened
    dupInput.duplicate = {
      jobId: "job-1234567890",
      outcome: "skipped",
      code: "already_done",
      contentBefore: 50,
      contentAfter: 50,
      decisionOutcomeBefore: "published/",
      decisionOutcomeAfter: "published/",
    };
    expect(find(dupInput, 13).status).toBe("pass");
    dupInput.duplicate = { ...dupInput.duplicate, contentAfter: 51 };
    expect(find(dupInput, 13).status).toBe("fail");
  });

  it("judges retention only for cleanups that ran", () => {
    const input = emptyInput();
    expect(find(input, 14).status).toBe("not_evaluated");
    input.cleanup.runs = { "cleanup-sessions": 1, "cleanup-persona-memory": 1 };
    input.cleanup.maxMemoriesAfterCleanup = [60];
    expect(find(input, 14).status).toBe("pass");
    input.cleanup.maxMemoriesAfterCleanup = [61];
    expect(find(input, 14).status).toBe("fail");
    input.cleanup.maxMemoriesAfterCleanup = [60];
    input.retention.expiredSessionsLeft = 1;
    expect(find(input, 14).status).toBe("fail");
  });
});

describe("repair and quarantine checks", () => {
  it("passes when repairs happened once per key and quarantine leaked nothing", () => {
    const input = emptyInput();
    input.scenario.faults = { ...input.scenario.faults, badDraftRate: 0.04 };
    input.repairCalls = 7;
    input.repairKeys = 7;
    input.quarantinedDecisions = 2;
    expect(find(input, 15).status).toBe("pass");
    expect(find(input, 16).status).toBe("pass");
  });

  it("fails on a key repaired twice", () => {
    const input = emptyInput();
    input.repairCalls = 3;
    input.repairKeys = 2;
    input.repairKeysOverLimit = 1;
    expect(find(input, 15).status).toBe("fail");
  });

  it("fails when a quarantined decision has published content", () => {
    const input = emptyInput();
    input.quarantinedDecisions = 1;
    input.quarantinedWithContent = 1;
    expect(find(input, 16).status).toBe("fail");
  });

  it("fails when bad drafts were injected but the paths never ran", () => {
    const input = emptyInput();
    input.scenario.faults = { ...input.scenario.faults, badDraftRate: 0.04 };
    expect(find(input, 15).status).toBe("fail");
    expect(find(input, 16).status).toBe("fail");
  });
});
