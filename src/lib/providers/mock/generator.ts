import { SeededRandom } from "@/lib/random";
import { latinToCyrillic } from "@/lib/serbian/latin-to-cyrillic";
import { findTopicalMarkers } from "@/lib/serbian/topics";
import { cyrillicToLatin } from "@/lib/serbian/transliterate";
import {
  syntheticUsage,
  type GenerationRequest,
  type GenerationResult,
  type Intent,
  type TextGenerationProvider,
} from "../types";

/**
 * Deterministic text generation for mock mode. Output is template-based
 * Serbian, seeded by the action key, so the same request always yields the
 * same text. It exists to exercise the whole pipeline (gate, persistence,
 * rendering) without a provider; it is not a substitute for a model.
 *
 * Templates avoid gendered past-tense forms so any persona can voice them, and
 * avoid words whose "nj" or "dž" are not digraphs so Cyrillic conversion is safe.
 */

/** Each names a place or concept from the topical marker list. */
const TOPICAL_ANCHORS: readonly string[] = [
  "Zanima me kako to izgleda u Srbiji danas.",
  "Pitam se da li je u Beogradu drugačije nego u unutrašnjosti.",
  "Zanimaju me iskustva iz Vojvodine i Šumadije.",
  "Kako to vidite vi, iz raznih krajeva Srbije?",
];

const OPENERS: Record<Intent, readonly string[]> = {
  introduce_topic: [
    "Predlažem da razgovaramo o ovome, jer se tiče mnogih u Srbiji.",
    "Ova tema zaslužuje pažnju, pa je otvaram uz izvore koje imamo.",
  ],
  ask_question: [
    "Zanima me jedna stvar u vezi sa ovim.",
    "Imam pitanje za one koji ovo bolje poznaju.",
  ],
  answer_question: [
    "Na to pitanje postoji prilično jasan odgovor.",
    "Evo šta se o tome može reći na osnovu dostupnih podataka.",
  ],
  add_context: [
    "Vredi dodati jedan podatak uz ovo.",
    "Kontekst koji ovde nedostaje je sledeći.",
  ],
  disagree: [
    "Ne slažem se sa tim zaključkom, i to iz konkretnog razloga.",
    "Argument zvuči uverljivo, ali ne drži vodu kad se pogledaju podaci.",
  ],
  alternative_interpretation: [
    "Isti podaci se mogu čitati i drugačije.",
    "Postoji i drugo tumačenje koje ovde nije pomenuto.",
  ],
  correct_earlier: [
    "Ispravka uz raniji komentar: prethodna tvrdnja nije bila precizna.",
    "Ranije navedeni podatak treba ispraviti.",
  ],
  summarize: [
    "Kratak pregled dosadašnje diskusije.",
    "Sažetak onoga što je do sada rečeno, uz otvorena pitanja.",
  ],
};

const CLOSERS: readonly string[] = [
  "Ako neko ima noviji podatak, neka ga podeli uz izvor.",
  "Otvoren sam za drugačije mišljenje, ali uz argumente.",
  "Bilo bi korisno da se uporede podaci iz više izvora.",
  "Ovo ostaje otvoreno pitanje dok se ne pojave novi podaci.",
];

const QUESTION_TAILS: readonly string[] = [
  "Da li neko zna kako to izgleda u praksi, recimo u Nišu ili Novom Sadu?",
  "Kako se to odražava na svakodnevicu ljudi u Srbiji?",
  "Postoji li zvaničan izvor koji to potvrđuje?",
];

function factSentence(request: GenerationRequest, rng: SeededRandom): string | null {
  const facts = request.context.facts ?? [];
  if (facts.length === 0) return null;
  const fact = rng.pick(facts);
  return `Prema izvoru „${fact.publisher}“ (${fact.title}): ${fact.summary}`;
}

function parentSentence(request: GenerationRequest): string | null {
  const chain = request.context.parentChain ?? [];
  const parent = chain.at(-1);
  if (!parent) return null;
  const excerpt = parent.body.replace(/\s+/g, " ").trim().slice(0, 90);
  return `Odgovor na komentar korisnika ${parent.author}: „${excerpt}${parent.body.length > 90 ? "…" : ""}“.`;
}

function styleSentence(request: GenerationRequest): string {
  const interest = request.persona.interests[0];
  if (interest) {
    return `Iz ugla nekoga koga zanima ${interest}, ovo je važno i za lokalnu zajednicu.`;
  }
  return "Iz ugla običnog čitaoca, ovo je važno i za lokalnu zajednicu.";
}

const SUMMARY_VERDICTS: readonly string[] = [
  "Učesnici se u osnovi slažu da je tema važna, ali tumače je različito.",
  "Mišljenja su podeljena, a razlike se uglavnom svode na to kako se čitaju dostupni podaci.",
  "Neka pitanja iz rasprave za sada ostaju otvorena.",
];

/** Neutral recap of the discussion: participants, one even-handed sentence, and the sources. */
function summaryBody(
  request: GenerationRequest,
  rng: SeededRandom,
): { body: string; ids: string[] } {
  const { threadTitle, recentComments = [], facts = [], threadSummary } = request.context;
  const names = [...new Set(recentComments.map((turn) => turn.author))].slice(0, 4);
  const parts: string[] = [
    `Sažetak rasprave o temi „${threadTitle ?? request.context.community.name}“.`,
  ];
  if (threadSummary) parts.push("Ovo dopunjuje prethodni sažetak novijim komentarima.");
  if (names.length >= 2) {
    parts.push(
      `U razgovoru su učestvovali ${names.slice(0, -1).join(", ")} i ${names.at(-1)}.`,
    );
  } else if (names.length === 1) {
    parts.push(`U razgovoru je učestvovao ${names[0]}.`);
  }
  parts.push(rng.pick(SUMMARY_VERDICTS));
  parts.push("Ono što nije potvrđeno izvorima treba uzeti sa rezervom.");
  const publishers = [...new Set(facts.map((fact) => fact.publisher))];
  parts.push(
    publishers.length > 0
      ? `Izvori: ${publishers.join(", ")}.`
      : "Izvori: u ovoj raspravi nisu navedeni.",
  );
  return { body: parts.join(" "), ids: facts.map((fact) => fact.id) };
}

export class MockGenerationProvider implements TextGenerationProvider {
  readonly name = "mock";
  readonly model = "mock-deterministic-v1";
  readonly configured = true;

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    if (request.purpose === "summary") {
      const summary = summaryBody(request, new SeededRandom(request.seed));
      const script = request.persona.scriptPreference;
      // Names and the title may be in the other script; one script per text.
      const body =
        script === "Cyrillic" ? latinToCyrillic(summary.body) : cyrillicToLatin(summary.body);
      return {
        body,
        script,
        evidenceIds: summary.ids,
        usage: syntheticUsage(request, body),
        provider: this.name,
        model: "mock-deterministic-v1",
      };
    }
    const rng = new SeededRandom(request.repair ? `${request.seed}:repair` : request.seed);
    const parts: string[] = [];
    const usedFacts: string[] = [];

    const opener = rng.pick(OPENERS[request.intent]);
    parts.push(opener);

    const parent = parentSentence(request);
    if (parent && request.purpose === "reply") parts.push(parent);

    const fact = factSentence(request, rng);
    if (fact) {
      parts.push(fact);
      const chosen = (request.context.facts ?? []).find((item) => fact.includes(item.title));
      if (chosen) usedFacts.push(chosen.id);
    } else if (request.context.threadTitle) {
      parts.push(
        `Tema „${request.context.threadTitle}“ otvara više pitanja nego što na prvi pogled izgleda.`,
      );
    }

    parts.push(styleSentence(request));

    if (request.intent === "ask_question") parts.push(rng.pick(QUESTION_TAILS));
    else parts.push(rng.pick(CLOSERS));

    let body = parts.join(" ");
    let title: string | undefined;
    if (request.purpose === "thread") {
      const hint = request.context.topicHint ?? request.context.community.name;
      title = `Razgovor: ${hint}`;
      // A new thread must tie to Serbia (the gate's topical check). When the
      // template names nothing Serbian, add a plain, gender-neutral anchor.
      const communityName = request.context.community.name;
      if (!findTopicalMarkers(`${title}\n${body}\n${communityName}`).hit) {
        body = `${body} ${rng.pick(TOPICAL_ANCHORS)}`;
      }
      body = `${body}\n\nZajednica: ${communityName}.`;
    }
    if (request.purpose === "revision" && request.context.currentBody) {
      const reason = request.context.revisionReason ?? "preciznije formulisano";
      body = `${request.context.currentBody}\n\nDopuna (${reason}): ${body}`;
    }

    const script = request.persona.scriptPreference;
    if (script === "Cyrillic") {
      body = latinToCyrillic(body);
      if (title) title = latinToCyrillic(title);
    } else {
      // Quoted parents and community names may be Cyrillic; a Latin persona writes one script.
      body = cyrillicToLatin(body);
      if (title) title = cyrillicToLatin(title);
    }

    let memoryNote: string | undefined;
    if (request.purpose === "thread" || request.purpose === "reply") {
      const subject = (title ?? request.context.threadTitle ?? request.context.community.name)
        .replace(/[„“”"]/g, "")
        .slice(0, 120);
      // Gender-neutral on purpose: personas of any gender share this template.
      memoryNote =
        request.purpose === "thread"
          ? `Otvorena tema „${subject}“.`
          : `Komentar u temi „${subject}“.`;
      memoryNote =
        script === "Cyrillic" ? latinToCyrillic(memoryNote) : cyrillicToLatin(memoryNote);
    }

    const outputText = `${title ?? ""}${body}${memoryNote ?? ""}`;
    return {
      title,
      body,
      script,
      evidenceIds: usedFacts,
      memoryNote,
      usage: syntheticUsage(request, outputText),
      provider: this.name,
      model: "mock-deterministic-v1",
    };
  }
}
