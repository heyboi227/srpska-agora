import { describe, expect, it } from "vitest";
import {
  countContextChars,
  fitContextSections,
  type ContextSections,
} from "@/lib/context/budget";
import { rankMemories, type MemoryCandidate } from "@/lib/context/memory";
import { STANDARD_PRESET } from "@/lib/config/presets";
import { runPublicationGate } from "@/lib/gates/publication-gate";
import { MockGenerationProvider } from "@/lib/providers/mock/generator";
import { MockValidationProvider } from "@/lib/providers/mock/validator";
import { SUMMARY_PERSONA } from "@/lib/domain/summaries";

const turn = (author: string, size: number, fill = "a") => ({
  author,
  body: fill.repeat(size),
});

function sections(over: Partial<ContextSections> = {}): ContextSections {
  return {
    community: { slug: "k", name: "Kuhinja", description: "d".repeat(100) },
    threadTitle: "Naslov",
    parentChain: [turn("A", 500, "p"), turn("B", 500, "q")],
    currentBody: undefined,
    revisionReason: undefined,
    threadSummary: "s".repeat(1000),
    facts: [1, 2, 3].map((n) => ({
      id: `f${n}`,
      publisher: "P",
      title: "T",
      summary: "x".repeat(300),
      publishedAt: "2026-09-01T00:00:00Z",
    })),
    recentComments: [turn("C", 300, "r"), turn("D", 300, "s"), turn("E", 300, "t")],
    memory: ["m".repeat(200), "n".repeat(200), "o".repeat(200)],
    ...over,
  };
}

describe("fitContextSections", () => {
  it("leaves a context within budget untouched", () => {
    const input = sections();
    const { sections: out, trimmed } = fitContextSections(input, 100_000);
    expect(trimmed).toEqual([]);
    expect(out).toEqual(input);
  });

  it("never mutates its input", () => {
    const input = sections();
    const copy = structuredClone(input);
    fitContextSections(input, 500);
    expect(input).toEqual(copy);
  });

  it("drops memory from the end first", () => {
    const input = sections();
    const total = countContextChars(input);
    const { sections: out, trimmed } = fitContextSections(input, total - 250);
    expect(out.memory).toEqual([input.memory[0]]);
    expect(trimmed).toEqual(["memory"]);
    expect(out.recentComments).toHaveLength(3);
  });

  it("then drops recent comments oldest first, then facts last-ranked first", () => {
    const input = sections();
    const withoutMemory = countContextChars({ ...input, memory: [] });
    const a = fitContextSections(input, withoutMemory - 100);
    expect(a.sections.memory).toEqual([]);
    expect(a.sections.recentComments.map((c) => c.author)).toEqual(["D", "E"]);
    expect(a.trimmed).toEqual(["memory", "recentComments"]);

    const withoutComments = countContextChars({ ...input, memory: [], recentComments: [] });
    const b = fitContextSections(input, withoutComments - 100);
    expect(b.sections.recentComments).toEqual([]);
    expect(b.sections.facts.map((f) => f.id)).toEqual(["f1", "f2"]);
  });

  it("then truncates the thread summary, and shortens the chain only last", () => {
    const input = sections();
    const base = countContextChars({
      ...input,
      memory: [],
      recentComments: [],
      facts: [],
      threadSummary: "",
    });
    const a = fitContextSections(input, base + 400);
    expect(a.sections.threadSummary?.length).toBe(400);
    expect(a.sections.parentChain).toEqual(input.parentChain);

    const b = fitContextSections(input, base - 300);
    expect(b.sections.threadSummary).toBeUndefined();
    // Oldest chain item is shortened first.
    expect(b.sections.parentChain[0]?.body.length).toBeLessThan(500);
    expect(b.sections.parentChain[1]?.body.length).toBe(500);
    expect(countContextChars(b.sections)).toBeLessThanOrEqual(base - 300);
    expect(b.trimmed).toContain("parentChain");
  });

  it("trims the opening post only after the chain, so it outlives every lower section", () => {
    const input = sections({ threadBody: "o".repeat(1000) });
    const minimum = countContextChars({
      ...input,
      memory: [],
      recentComments: [],
      facts: [],
      threadSummary: "",
    });
    // Chain bodies shrink toward their floor before the opening post is touched.
    const tight = fitContextSections(input, minimum - 400);
    expect(tight.sections.threadBody?.length).toBe(1000);
    expect(tight.trimmed).toContain("parentChain");
    expect(tight.trimmed).not.toContain("threadBody");
    // Past the chain floor the opening post finally gives way.
    const tiny = fitContextSections(input, 1200);
    expect(tiny.sections.threadBody?.length ?? 0).toBeLessThan(1000);
    expect(tiny.trimmed).toContain("threadBody");
    expect(tiny.sections.threadTitle).toBe("Naslov");
  });

  it("never cuts the community, title or current body", () => {
    const input = sections({ currentBody: "c".repeat(3000) });
    const { sections: out } = fitContextSections(input, 100);
    expect(out.currentBody?.length).toBe(3000);
    expect(out.threadTitle).toBe("Naslov");
    expect(out.community.description.length).toBe(100);
  });
});

describe("rankMemories", () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 8, 1, 10, minutes));
  const mem = (
    content: string,
    minutes: number,
    threadId: string | null,
    communityId: string | null,
  ): MemoryCandidate => ({ content, threadId, communityId, createdAt: at(minutes) });
  const limits = { items: 8, totalChars: 800, itemChars: 200 };

  it("ranks same thread, then same community, then the rest, newest first", () => {
    const list = [
      mem("other-new", 50, "t9", "c9"),
      mem("comm-old", 10, "t2", "c1"),
      mem("thread-old", 5, "t1", "c1"),
      mem("comm-new", 40, "t3", "c1"),
      mem("thread-new", 30, "t1", "c1"),
      mem("none", 45, null, null),
    ];
    expect(rankMemories(list, { threadId: "t1", communityId: "c1" }, limits)).toEqual([
      "thread-new",
      "thread-old",
      "comm-new",
      "comm-old",
      "other-new",
      "none",
    ]);
  });

  it("truncates entries and stops at the item and character limits", () => {
    const long = Array.from({ length: 12 }, (_, i) => mem("x".repeat(500), i, null, null));
    const picked = rankMemories(long, {}, limits);
    expect(picked).toHaveLength(4);
    expect(picked.every((p) => p.length === 200)).toBe(true);
    const short = Array.from({ length: 12 }, (_, i) => mem(`kratko ${i}`, i, null, null));
    expect(rankMemories(short, {}, limits)).toHaveLength(8);
  });
});

describe("mock summary", () => {
  const generator = new MockGenerationProvider();
  const validator = new MockValidationProvider();

  for (const script of ["Latin", "Cyrillic"] as const) {
    it(`passes the publication gate in ${script}`, async () => {
      const facts = [
        {
          id: "11111111-1111-4111-8111-111111111111",
          publisher: "Pijaca Info",
          title: "Cene povrća na pijacama",
          summary: "Cene povrća na pijacama u Srbiji.",
          publishedAt: "2026-09-01T00:00:00Z",
        },
      ];
      const result = await generator.generate({
        purpose: "summary",
        persona: { ...SUMMARY_PERSONA, scriptPreference: script },
        intent: "summarize",
        context: {
          community: { slug: "kuhinja", name: "Kuhinja", description: "Recepti i pijace." },
          threadTitle: "Kako čuvate ajvar preko zime u Srbiji?",
          recentComments: [
            { author: "Slavica iz Zrenjanina", body: "Ja pravim ajvar u tegle." },
            { author: "Радмила из Шумадије", body: "Ja ne." },
            { author: "Skeptik sa izvorom", body: "Odakle taj podatak?" },
          ],
          facts,
          memory: [],
        },
        seed: "summary-test",
        maxOutputTokens: 1000,
        maxBodyCharacters: 1500,
      });
      expect(result.script).toBe(script);
      expect(result.evidenceIds).toEqual([facts[0]!.id]);
      expect(result.body).not.toContain("Izvori: u ovoj");
      // One script only, even when a participant name is in the other.
      expect(/[Ѐ-ӿ]/.test(result.body)).toBe(script === "Cyrillic");
      if (script === "Latin") expect(result.body).toContain("Radmila iz Šumadije");
      const report = await runPublicationGate(
        {
          kind: "summary",
          body: result.body,
          context: {
            communitySlug: "kuhinja",
            communityName: "Kuhinja",
            inheritsTopic: true,
            threadTitle: "Kako čuvate ajvar preko zime u Srbiji?",
          },
          evidence: facts,
          claimedEvidenceIds: result.evidenceIds,
          seed: "summary-test",
        },
        { config: STANDARD_PRESET, validator },
      );
      expect(report.codes).toEqual([]);
      expect(report.outcome).toBe("pass");
      expect(report.script).toBe(script);
    });
  }
});
