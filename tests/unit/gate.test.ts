import { describe, expect, it } from "vitest";
import { STANDARD_PRESET } from "@/lib/config/presets";
import { runPublicationGate, type GateInput } from "@/lib/gates/publication-gate";
import { NotConfiguredValidation } from "@/lib/providers/not-configured";
import { MockValidationProvider, MODERATION_TEST_MARKER } from "@/lib/providers/mock/validator";

const deps = { config: STANDARD_PRESET, validator: new MockValidationProvider() };
const context = { communitySlug: "kuhinja", communityName: "Kuhinja", inheritsTopic: false };

const serbianThread: GateInput = {
  kind: "thread",
  title: "Kako čuvate ajvar preko zime u Srbiji?",
  body:
    "Svake jeseni ista dilema: tegle od kile ili manje? Zanima me kako to radite u Vojvodini, a kako u Šumadiji. " +
    "Moje iskustvo je da se ajvar najbolje drži u tamnoj ostavi, ali čujem različita mišljenja.",
  context,
  seed: "test:thread:ajvar",
};

describe("runPublicationGate", () => {
  it("passes a Serbian thread with a topical marker", async () => {
    const report = await runPublicationGate(serbianThread, deps);
    expect(report.outcome).toBe("pass");
    expect(report.script).toBe("Latin");
    expect(report.validator?.verdict).toBe("pass");
  });

  it("passes Cyrillic content and records the script", async () => {
    const report = await runPublicationGate(
      {
        kind: "thread",
        title: "Које књиге о историји Београда препоручујете?",
        body: "Тражим нешто што није уџбеник, а да покрива и Земун и Стари град. Хвала унапред свима који одговоре.",
        context: { ...context, communitySlug: "kultura", communityName: "Kultura" },
        seed: "test:thread:knjige",
      },
      deps,
    );
    expect(report.outcome).toBe("pass");
    expect(report.script).toBe("Cyrillic");
  });

  it("quarantines English without calling the validator", async () => {
    const report = await runPublicationGate(
      {
        kind: "thread",
        title: "Best places to eat in Belgrade",
        body: "I visited Belgrade last week and the food was amazing. What are your favourite restaurants in Serbia?",
        context,
        seed: "test:thread:english",
      },
      deps,
    );
    expect(report.outcome).toBe("quarantine");
    expect(report.codes).toContain("language_english");
    expect(report.validator).toBeNull();
  });

  it("quarantines a thread with no Serbian connection", async () => {
    const report = await runPublicationGate(
      {
        kind: "thread",
        title: "Koji je najbolji način da se nauči gitara?",
        body: "Počeo bih da učim gitaru od nule. Da li su bolji časovi uživo ili snimci? Koliko vremena dnevno treba vežbati?",
        context,
        seed: "test:thread:gitara",
      },
      deps,
    );
    expect(report.outcome).toBe("quarantine");
    expect(report.codes).toContain("no_topical_marker");
  });

  it("lets a short reply inherit the thread topic", async () => {
    const report = await runPublicationGate(
      {
        kind: "comment",
        body: "Slažem se, tegle od kile su praktičnije.",
        context: { ...context, inheritsTopic: true, threadTitle: serbianThread.title },
        seed: "test:comment:kratko",
      },
      deps,
    );
    expect(report.outcome).toBe("pass");
  });

  it("quarantines invented citations", async () => {
    const report = await runPublicationGate(
      {
        ...serbianThread,
        evidence: [{ id: "a1", title: "Demo", summary: "Demo sažetak." }],
        claimedEvidenceIds: ["a1", "does-not-exist"],
      },
      deps,
    );
    expect(report.outcome).toBe("quarantine");
    expect(report.codes).toContain("invented_citation");
  });

  it("enforces length limits and encoding rules", async () => {
    const tooLong = await runPublicationGate(
      { ...serbianThread, body: "Srbija. ".repeat(1000) },
      deps,
    );
    expect(tooLong.codes).toContain("body_too_long");

    const bidi = await runPublicationGate(
      { ...serbianThread, body: `${serbianThread.body}‮` },
      deps,
    );
    expect(bidi.codes).toContain("bidi_or_zero_width");

    const shortTitle = await runPublicationGate({ ...serbianThread, title: "Ajvar" }, deps);
    expect(shortTitle.codes).toContain("title_too_short");
  });

  it("quarantines mixed-script text", async () => {
    const report = await runPublicationGate(
      {
        kind: "comment",
        body: "Ово је pola ћирилица a pola latinica, што није у реду za jedan komentar.",
        context: { ...context, inheritsTopic: true },
        seed: "test:comment:mixed",
      },
      deps,
    );
    expect(report.outcome).toBe("quarantine");
    expect(report.codes).toContain("mixed_script");
  });

  it("lets the validator reject on moderation grounds", async () => {
    const report = await runPublicationGate(
      { ...serbianThread, body: `${serbianThread.body} ${MODERATION_TEST_MARKER}` },
      deps,
    );
    expect(report.outcome).toBe("quarantine");
    expect(report.codes).toContain("validator_rejected");
    expect(report.codes).toContain("validator:moderation");
  });

  it("never publishes when the validator is not configured", async () => {
    const report = await runPublicationGate(serbianThread, {
      config: STANDARD_PRESET,
      validator: new NotConfiguredValidation(),
    });
    expect(report.outcome).toBe("quarantine");
    expect(report.codes).toContain("validator_not_configured");
  });

  it("checks a revision reason for language too", async () => {
    const report = await runPublicationGate(
      {
        ...serbianThread,
        kind: "revision_thread",
        notes: ["Fixed a typo in the title and body text"],
      },
      deps,
    );
    expect(report.outcome).toBe("quarantine");
    expect(report.codes.some((code) => code.startsWith("note_language_"))).toBe(true);
  });
});
