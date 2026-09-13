import { cyrillicToLatin } from "./transliterate";

/**
 * Search normalisation. The original text is always stored untouched; this
 * produces a derived representation in which Cyrillic and Latin, and text with
 * or without diacritics, compare equal. "đ" folds to "dj" because that is how
 * people type it without the letter available.
 */

const FOLD: Record<string, string> = {
  č: "c",
  ć: "c",
  ž: "z",
  š: "s",
  đ: "dj",
};

export function foldSerbianDiacritics(latinLower: string): string {
  let out = "";
  for (const char of latinLower) out += FOLD[char] ?? char;
  return out;
}

/** Removes combining marks from letters of any language (é -> e, ł stays ł). */
function stripCombiningMarks(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .normalize("NFC");
}

/**
 * Lower-case Latin text without diacritics or punctuation, single-spaced.
 * Both "Ђорђе из Ниша" and "Djordje iz Nisa" normalise to "djordje iz nisa".
 */
export function normalizeForSearch(input: string): string {
  const latin = cyrillicToLatin(input).toLowerCase();
  const folded = stripCombiningMarks(foldSerbianDiacritics(latin));
  return folded
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Alphabetic tokens of the normalised text; numbers are dropped. */
export function tokenizeWords(input: string): string[] {
  return normalizeForSearch(input)
    .split(" ")
    .filter((token) => token.length > 0 && /^\p{L}+$/u.test(token));
}
