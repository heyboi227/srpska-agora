import { describe, expect, it } from "vitest";
import { cronMatches, minutesBetween } from "@/lib/simulation/cron";
import { decideBadDraft, decideFault, FaultInjector } from "@/lib/simulation/faults";
import { createProviders } from "@/lib/providers";
import { ProviderCallError, type GenerationRequest } from "@/lib/providers/types";
import { CLEANUP_SCHEDULE } from "@/lib/jobs/cleanup";

// 2026-11-02 is winter time in Belgrade (UTC+1).
const at = (utc: string): Date => new Date(utc);

describe("cronMatches (Belgrade time)", () => {
  it("matches a daily time in local hours, not UTC", () => {
    expect(cronMatches("10 3 * * *", at("2026-11-03T02:10:00Z"))).toBe(true);
    expect(cronMatches("10 3 * * *", at("2026-11-03T03:10:00Z"))).toBe(false);
    expect(cronMatches("10 3 * * *", at("2026-11-03T02:11:00Z"))).toBe(false);
  });

  it("matches summer time with a two hour offset", () => {
    expect(cronMatches("10 3 * * *", at("2026-07-03T01:10:00Z"))).toBe(true);
  });

  it("handles hourly and stepped minutes", () => {
    expect(cronMatches("5 * * * *", at("2026-11-02T04:05:00Z"))).toBe(true);
    expect(cronMatches("5 * * * *", at("2026-11-02T04:06:00Z"))).toBe(false);
    for (const minute of [0, 10, 20, 30, 40, 50]) {
      const date = new Date(Date.UTC(2026, 10, 2, 4, minute));
      expect(cronMatches("*/10 * * * *", date)).toBe(true);
    }
    expect(cronMatches("*/10 * * * *", at("2026-11-02T04:15:00Z"))).toBe(false);
  });

  it("supports lists and ranges, and rejects fields it does not understand", () => {
    expect(cronMatches("0,30 8-10 * * *", at("2026-11-02T08:30:00Z"))).toBe(true); // 09:30 local
    expect(cronMatches("0,30 8-10 * * *", at("2026-11-02T10:30:00Z"))).toBe(false); // 11:30 local
    expect(() => cronMatches("0 3 1 * *", at("2026-11-02T04:00:00Z"))).toThrow();
    expect(() => cronMatches("0 3 * *", at("2026-11-02T04:00:00Z"))).toThrow();
  });

  it("fires every schedule in use exactly as often as expected over a day", () => {
    const minutes = minutesBetween(at("2026-11-02T03:59:00Z"), at("2026-11-03T03:59:00Z"));
    expect(minutes).toHaveLength(1440);
    const count = (cron: string): number => minutes.filter((m) => cronMatches(cron, m)).length;
    for (const entry of CLEANUP_SCHEDULE) {
      const expected = { "10 3 * * *": 1, "5 * * * *": 24, "20 3 * * *": 1, "30 3 * * *": 1 }[
        entry.cron
      ];
      expect(count(entry.cron)).toBe(expected ?? 144);
    }
  });
});

describe("minutesBetween", () => {
  it("lists the whole minutes after the start up to and including the end", () => {
    const list = minutesBetween(at("2026-11-02T04:00:00Z"), at("2026-11-02T04:02:00Z"));
    expect(list.map((d) => d.toISOString())).toEqual([
      "2026-11-02T04:01:00.000Z",
      "2026-11-02T04:02:00.000Z",
    ]);
    expect(minutesBetween(at("2026-11-02T04:00:00Z"), at("2026-11-02T04:00:30Z"))).toEqual([]);
  });
});

describe("decideFault", () => {
  const rates = { transientRate: 0.03, ambiguousRate: 0.01 };
  const none = new Set<string>();

  it("is a pure function of the seed, the key and the call index", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(decideFault("s", rates, `k${i}`, 0, none)).toBe(
        decideFault("s", rates, `k${i}`, 0, none),
      );
    }
  });

  it("gives retries a fresh draw and different seeds different draws", () => {
    const sequences = new Set<string>();
    for (const seed of ["a", "b", "c", "d"]) {
      let line = "";
      for (let i = 0; i < 200; i += 1)
        line += decideFault(seed, rates, "key", i, none) ? "x" : ".";
      sequences.add(line);
    }
    expect(sequences.size).toBeGreaterThan(1);
  });

  it("hits roughly the configured rates", () => {
    let transient = 0;
    let ambiguous = 0;
    const n = 20_000;
    for (let i = 0; i < n; i += 1) {
      const fault = decideFault("rates", rates, `key-${i}`, 0, none);
      if (fault === "transient") transient += 1;
      if (fault === "ambiguous") ambiguous += 1;
    }
    expect(transient / n).toBeGreaterThan(0.02);
    expect(transient / n).toBeLessThan(0.04);
    expect(ambiguous / n).toBeGreaterThan(0.005);
    expect(ambiguous / n).toBeLessThan(0.015);
  });

  it("never injects anything at rate zero and always fails scripted keys", () => {
    const off = { transientRate: 0, ambiguousRate: 0 };
    for (let i = 0; i < 100; i += 1) expect(decideFault("s", off, `k${i}`, i, none)).toBeNull();
    expect(decideFault("s", off, "doomed", 7, new Set(["doomed"]))).toBe("permanent");
  });
});

describe("FaultInjector", () => {
  const request = (seed: string): GenerationRequest =>
    ({
      purpose: "thread",
      persona: {
        id: "p",
        slug: "p",
        displayName: "Pera",
        style: "kratko",
        scriptPreference: "Latin",
        vocabularyNotes: "",
        interests: [],
      },
      intent: "introduce_topic",
      context: { community: { slug: "s", name: "S", description: "d" } },
      seed,
      maxOutputTokens: 100,
      maxBodyCharacters: 500,
    }) as unknown as GenerationRequest;

  it("fails a scripted key on every attempt with a retryable, unbilled error", async () => {
    const injector = new FaultInjector("seed", { transientRate: 0, ambiguousRate: 0 });
    injector.failPermanently("doomed");
    const provider = injector.wrap(createProviders("mock").generation);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const error = await provider.generate(request("doomed")).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderCallError);
      expect((error as ProviderCallError).retryable).toBe(true);
      expect((error as ProviderCallError).billing).toBe("not_billed");
    }
    expect(injector.tally.permanent).toBe(3);
    expect(injector.scriptedFailures).toEqual(["doomed"]);
  });

  it("passes other keys through and counts every call", async () => {
    const injector = new FaultInjector("seed", { transientRate: 0, ambiguousRate: 0 });
    const provider = injector.wrap(createProviders("mock").generation);
    const result = await provider.generate(request("fine"));
    expect(result.body.length).toBeGreaterThan(0);
    expect(injector.tally).toMatchObject({
      calls: 1,
      transient: 0,
      ambiguous: 0,
      permanent: 0,
    });
  });

  it("raises ambiguous errors when only that rate is on", async () => {
    const injector = new FaultInjector("seed", { transientRate: 0, ambiguousRate: 1 });
    const provider = injector.wrap(createProviders("mock").generation);
    const error = await provider.generate(request("any")).catch((e: unknown) => e);
    expect((error as ProviderCallError).billing).toBe("ambiguous");
    expect((error as ProviderCallError).retryable).toBe(true);
  });
});

describe("bad drafts", () => {
  const rates = { transientRate: 0, ambiguousRate: 0, badDraftRate: 0.04 };

  it("is a pure function of seed and key, and zero without a rate", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(decideBadDraft("s", rates, `k${i}`)).toEqual(decideBadDraft("s", rates, `k${i}`));
      expect(decideBadDraft("s", { ...rates, badDraftRate: 0 }, `k${i}`).bad).toBe(false);
    }
  });

  it("hits about 4 percent, and about a third of those have a bad repair", () => {
    let bad = 0;
    let badRepair = 0;
    const n = 20_000;
    for (let i = 0; i < n; i += 1) {
      const d = decideBadDraft("rates", rates, `key-${i}`);
      if (d.bad) bad += 1;
      if (d.badRepair) badRepair += 1;
      // A bad repair only follows a bad draft.
      if (d.badRepair) expect(d.bad).toBe(true);
    }
    expect(bad / n).toBeGreaterThan(0.03);
    expect(bad / n).toBeLessThan(0.05);
    expect(badRepair / bad).toBeGreaterThan(0.25);
    expect(badRepair / bad).toBeLessThan(0.42);
  });

  it("returns English for the first draft, and for the repair only when chosen", async () => {
    const all = { transientRate: 0, ambiguousRate: 0, badDraftRate: 1 };
    const provider = new FaultInjector("seed", all).wrap(createProviders("mock").generation);
    const base = {
      purpose: "reply",
      persona: {
        id: "p",
        slug: "p",
        displayName: "Pera",
        style: "kratko",
        scriptPreference: "Latin",
        vocabularyNotes: "",
        interests: [],
      },
      intent: "add_context",
      context: { community: { slug: "s", name: "S", description: "d" } },
      maxOutputTokens: 100,
      maxBodyCharacters: 500,
    } as unknown as GenerationRequest;
    const first = await provider.generate({ ...base, seed: "a" });
    expect(first.body).toContain("English");
    // Find one key whose repair is good and one whose repair is bad.
    let good: string | null = null;
    let worse: string | null = null;
    for (let i = 0; i < 200 && (!good || !worse); i += 1) {
      const d = decideBadDraft("seed", all, `k${i}`);
      if (d.badRepair) worse ??= `k${i}`;
      else good ??= `k${i}`;
    }
    const repair = { previousBody: "x", codes: ["language_english"] };
    const fixed = await provider.generate({ ...base, seed: good!, repair });
    expect(fixed.body).not.toContain("English");
    const still = await provider.generate({ ...base, seed: worse!, repair });
    expect(still.body).toContain("English");
  });

  it("never spoils a summary", async () => {
    const all = { transientRate: 0, ambiguousRate: 0, badDraftRate: 1 };
    const injector = new FaultInjector("seed", all);
    const provider = injector.wrap(createProviders("mock").generation);
    const request = {
      purpose: "summary",
      persona: {
        id: "system-summary",
        slug: "s",
        displayName: "Sistem",
        style: "kratko",
        scriptPreference: "Latin",
        vocabularyNotes: "",
        interests: [],
      },
      intent: "summarize",
      context: {
        community: { slug: "kuhinja", name: "Kuhinja", description: "d" },
        threadTitle: "Naslov",
        recentComments: [{ author: "A", body: "Komentar o ajvaru." }],
        facts: [],
        memory: [],
      },
      seed: "sum",
      maxOutputTokens: 100,
      maxBodyCharacters: 500,
    } as unknown as GenerationRequest;
    await provider.generate(request);
    expect(injector.tally.badDrafts).toBe(0);
  });
});
