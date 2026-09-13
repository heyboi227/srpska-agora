import { SeededRandom } from "@/lib/random";
import { latinToCyrillic } from "@/lib/serbian/latin-to-cyrillic";
import {
  ZERO_USAGE,
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

export class MockGenerationProvider implements TextGenerationProvider {
  readonly name = "mock";
  readonly configured = true;

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    const rng = new SeededRandom(request.seed);
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
      body = `${body}\n\nZajednica: ${request.context.community.name}.`;
    }
    if (request.purpose === "revision" && request.context.currentBody) {
      const reason = request.context.revisionReason ?? "preciznije formulisano";
      body = `${request.context.currentBody}\n\nDopuna (${reason}): ${body}`;
    }

    const script = request.persona.scriptPreference;
    if (script === "Cyrillic") {
      body = latinToCyrillic(body);
      if (title) title = latinToCyrillic(title);
    }

    return {
      title,
      body,
      script,
      evidenceIds: usedFacts,
      usage: ZERO_USAGE,
      provider: this.name,
      model: "mock-deterministic-v1",
    };
  }
}
