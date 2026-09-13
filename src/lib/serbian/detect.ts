import {
  ENGLISH_FUNCTION_WORDS,
  REGIONAL_LANGUAGE_MARKERS,
  SERBIAN_FUNCTION_WORDS,
} from "./lexicon";
import { tokenizeWords } from "./normalize";
import { analyzeScript, type ScriptProfile } from "./script";

/**
 * Heuristic language assessment. This is the inexpensive first pass of the
 * publication gate. It is confident about alphabets and about English, and
 * honest about everything else: doubt becomes "uncertain" or
 * "other_language_markers", both of which quarantine the text for review
 * instead of publishing it.
 */

export type LanguageOutcome =
  | "serbian"
  | "likely_serbian"
  | "uncertain"
  | "english"
  | "foreign_alphabet"
  | "other_language_markers";

export type LanguageCode =
  | "foreign_alphabet"
  | "foreign_cyrillic_letters"
  | "foreign_latin_letters"
  | "mixed_script"
  | "english_text"
  | "regional_language_markers"
  | "weak_serbian_signal"
  | "no_serbian_signal";

export interface LanguageAssessment {
  outcome: LanguageOutcome;
  /** 0..1, a rough confidence that the text is Serbian. */
  confidence: number;
  codes: LanguageCode[];
  tokens: number;
  serbianHits: number;
  englishHits: number;
  regionalHits: number;
  script: ScriptProfile;
}

/** Whether the outcome permits publication without a second opinion. */
export function isAcceptableLanguage(outcome: LanguageOutcome): boolean {
  return outcome === "serbian" || outcome === "likely_serbian";
}

export function assessSerbian(text: string): LanguageAssessment {
  const script = analyzeScript(text);
  const codes: LanguageCode[] = [];
  const tokens = tokenizeWords(text);

  let serbianHits = 0;
  let englishHits = 0;
  let regionalHits = 0;
  for (const token of tokens) {
    if (SERBIAN_FUNCTION_WORDS.has(token)) serbianHits += 1;
    if (ENGLISH_FUNCTION_WORDS.has(token)) englishHits += 1;
    if (REGIONAL_LANGUAGE_MARKERS.has(token)) regionalHits += 1;
  }

  const base = {
    codes,
    tokens: tokens.length,
    serbianHits,
    englishHits,
    regionalHits,
    script,
  };

  // Alphabet checks first: they are the only part of this that is near certain.
  const otherAllowance = Math.max(2, Math.floor(script.letters * 0.02));
  if (script.otherScript > otherAllowance) {
    codes.push("foreign_alphabet");
    return { ...base, outcome: "foreign_alphabet", confidence: 0 };
  }
  const foreignCyrillicAllowance = Math.max(2, Math.floor(script.letters * 0.03));
  if (script.foreignCyrillic > foreignCyrillicAllowance) {
    codes.push("foreign_alphabet");
    return { ...base, outcome: "foreign_alphabet", confidence: 0 };
  }
  if (script.foreignCyrillic > 0) codes.push("foreign_cyrillic_letters");

  const foreignLatinAllowance = Math.max(3, Math.floor(script.letters * 0.05));
  const foreignLatinHeavy = script.foreignLatin > foreignLatinAllowance;
  if (foreignLatinHeavy) codes.push("foreign_latin_letters");
  if (script.dominant === "Mixed") codes.push("mixed_script");

  const serbianSignal = serbianHits > 0 || script.serbianDiacritics > 0 || script.cyrillic > 0;

  // English is the most likely failure mode of a generic model; catch it firmly.
  if (englishHits >= 2 && englishHits > serbianHits) {
    codes.push("english_text");
    return { ...base, outcome: "english", confidence: 0 };
  }
  if (englishHits >= 1 && serbianHits === 0 && !serbianSignal && tokens.length <= 6) {
    codes.push("english_text");
    return { ...base, outcome: "english", confidence: 0 };
  }

  if (regionalHits >= 2 && regionalHits * 4 >= serbianHits) {
    codes.push("regional_language_markers");
    return { ...base, outcome: "other_language_markers", confidence: 0.3 };
  }

  if (foreignLatinHeavy) {
    return { ...base, outcome: "uncertain", confidence: 0.3 };
  }

  if (tokens.length < 3) {
    if (serbianSignal) {
      return { ...base, outcome: "likely_serbian", confidence: 0.6 };
    }
    codes.push("no_serbian_signal");
    return { ...base, outcome: "uncertain", confidence: 0.2 };
  }

  const ratio = serbianHits / tokens.length;
  if (ratio >= 0.15) {
    return { ...base, outcome: "serbian", confidence: Math.min(1, 0.6 + ratio) };
  }
  if (ratio >= 0.06 || serbianSignal) {
    return { ...base, outcome: "likely_serbian", confidence: 0.55 };
  }
  codes.push("weak_serbian_signal");
  return { ...base, outcome: "uncertain", confidence: 0.25 };
}
