/**
 * Serbian Latin to Cyrillic for text this application composes itself (mock
 * templates, system notices). The direction is ambiguous in general: "nj" and
 * "dž" are usually digraphs but not in words such as injekcija or nadživeti.
 * A public display toggle over arbitrary text needs a proper exception
 * dictionary and is deliberately not built on this function.
 */

const SINGLE: Record<string, string> = {
  a: "а",
  b: "б",
  c: "ц",
  č: "ч",
  ć: "ћ",
  d: "д",
  đ: "ђ",
  e: "е",
  f: "ф",
  g: "г",
  h: "х",
  i: "и",
  j: "ј",
  k: "к",
  l: "л",
  m: "м",
  n: "н",
  o: "о",
  p: "п",
  r: "р",
  s: "с",
  š: "ш",
  t: "т",
  u: "у",
  v: "в",
  z: "з",
  ž: "ж",
};

const DIGRAPH: Record<string, string> = { lj: "љ", nj: "њ", dž: "џ" };

/** Words (lower case, Latin) in which a would-be digraph is two letters. */
const NOT_DIGRAPH_WORDS = new Set([
  "injekcija",
  "injekcije",
  "injekciju",
  "konjugacija",
  "konjunkcija",
  "konjunktura",
  "tanjug",
  "nadživeti",
  "nadživi",
  "nadživeo",
  "nadživela",
  "podžanr",
  "odžalovati",
]);

function mapSingle(char: string): string {
  const lower = char.toLowerCase();
  const mapped = SINGLE[lower];
  if (mapped === undefined) return char;
  return char === lower ? mapped : mapped.toUpperCase();
}

function convertWord(word: string): string {
  const lower = word.toLowerCase();
  const digraphsAllowed = !NOT_DIGRAPH_WORDS.has(lower);
  let out = "";
  for (let i = 0; i < word.length; i += 1) {
    const pair = word.slice(i, i + 2);
    const pairLower = pair.toLowerCase();
    const digraph = digraphsAllowed ? DIGRAPH[pairLower] : undefined;
    if (digraph !== undefined && pair.length === 2) {
      const first = pair[0] as string;
      out += first === first.toLowerCase() ? digraph : digraph.toUpperCase();
      i += 1;
      continue;
    }
    out += mapSingle(word[i] as string);
  }
  return out;
}

export function latinToCyrillic(input: string): string {
  const text = input.normalize("NFC");
  // Convert word by word so the exception list can see whole words.
  return text.replace(/[\p{L}]+/gu, (word) => convertWord(word));
}
