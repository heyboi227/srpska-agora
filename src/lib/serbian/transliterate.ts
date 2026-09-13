/**
 * Serbian Cyrillic to Serbian Latin. This direction is unambiguous: every
 * Cyrillic letter maps to exactly one Latin letter or digraph. The reverse
 * direction is not (nadživeti, injekcija), which is why a Latin to Cyrillic
 * display toggle is deferred and will need a dictionary of exceptions.
 */

const LOWER: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  ђ: "đ",
  е: "e",
  ж: "ž",
  з: "z",
  и: "i",
  ј: "j",
  к: "k",
  л: "l",
  љ: "lj",
  м: "m",
  н: "n",
  њ: "nj",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  ћ: "ć",
  у: "u",
  ф: "f",
  х: "h",
  ц: "c",
  ч: "č",
  џ: "dž",
  ш: "š",
};

const DIGRAPHS = new Set(["љ", "њ", "џ"]);

function isUpperCaseLetter(char: string | undefined): boolean {
  if (!char) return false;
  return /\p{Lu}/u.test(char);
}

function isLowerCaseLetter(char: string | undefined): boolean {
  if (!char) return false;
  return /\p{Ll}/u.test(char);
}

/**
 * Transliterates Serbian Cyrillic letters to Latin; every other character is
 * kept as is, so URLs, numbers, Latin text, and foreign letters pass through.
 * Upper-case digraphs become "Lj" inside a capitalised word and "LJ" inside an
 * all-caps word, judged from the neighbouring letters.
 */
export function cyrillicToLatin(input: string): string {
  const text = input.normalize("NFC");
  const chars = Array.from(text);
  let out = "";
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i] as string;
    const lower = char.toLowerCase();
    const mapped = LOWER[lower];
    if (mapped === undefined) {
      out += char;
      continue;
    }
    if (char === lower) {
      out += mapped;
      continue;
    }
    if (!DIGRAPHS.has(lower)) {
      out += mapped.toUpperCase();
      continue;
    }
    const next = chars[i + 1];
    const previous = chars[i - 1];
    const allCaps =
      isUpperCaseLetter(next) || (isUpperCaseLetter(previous) && !isLowerCaseLetter(next));
    out += allCaps
      ? mapped.toUpperCase()
      : (mapped[0] as string).toUpperCase() + mapped.slice(1);
  }
  return out;
}
