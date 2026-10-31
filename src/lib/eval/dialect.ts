import { cyrillicToLatin } from "@/lib/serbian/transliterate";

/**
 * A small Ekavian/Ijekavian lexicon heuristic for the evaluation. It only
 * counts words it recognises, so text without any of them is "unknown" and
 * is left out of the adherence rate instead of counting as a pass or a fail.
 */

const EKAVIAN = [
  "vreme",
  "vremenu",
  "vremenom",
  "mleko",
  "mleka",
  "mleku",
  "dete",
  "deteta",
  "detetu",
  "reka",
  "reke",
  "reku",
  "rekom",
  "lep",
  "lepa",
  "lepo",
  "lepe",
  "lepi",
  "svet",
  "sveta",
  "svetu",
  "svetom",
  "beo",
  "bela",
  "belo",
  "beli",
  "mesto",
  "mesta",
  "mestu",
  "verovatno",
  "reč",
  "reči",
  "hteo",
  "hteli",
  "videli",
  "živeli",
];

const IJEKAVIAN = [
  "vrijeme",
  "vrijemenu",
  "mlijeko",
  "mlijeka",
  "mlijeku",
  "dijete",
  "djeteta",
  "djetetu",
  "rijeka",
  "rijeke",
  "rijeku",
  "rijekom",
  "lijep",
  "lijepa",
  "lijepo",
  "lijepe",
  "lijepi",
  "svijet",
  "svijeta",
  "svijetu",
  "svijetom",
  "bijel",
  "bijela",
  "bijelo",
  "bijeli",
  "mjesto",
  "mjesta",
  "mjestu",
  "vjerovatno",
  "vjerojatno",
  "riječ",
  "riječi",
  "htio",
  "htjeli",
  "vidjeli",
  "živjeli",
];

const EKAVIAN_SET = new Set(EKAVIAN.map((w) => w.normalize("NFC")));
const IJEKAVIAN_SET = new Set(IJEKAVIAN.map((w) => w.normalize("NFC")));

export type Dialect = "ekavian" | "ijekavian";
export type DialectReading = "ekavian" | "ijekavian" | "mixed" | "unknown";
export type DialectAdherence = "match" | "mismatch" | "not_assessable";

export interface DialectDetection {
  ekavian: number;
  ijekavian: number;
  reading: DialectReading;
}

/** Lower-case Latin words; Cyrillic is transliterated first. */
function words(text: string): string[] {
  return cyrillicToLatin(text.normalize("NFC"))
    .toLowerCase()
    .split(/[^a-zčćžšđ]+/u)
    .filter(Boolean);
}

export function detectDialect(text: string): DialectDetection {
  let ekavian = 0;
  let ijekavian = 0;
  for (const word of words(text)) {
    if (EKAVIAN_SET.has(word)) ekavian += 1;
    if (IJEKAVIAN_SET.has(word)) ijekavian += 1;
  }
  const reading: DialectReading =
    ekavian === 0 && ijekavian === 0
      ? "unknown"
      : ekavian > 0 && ijekavian > 0
        ? "mixed"
        : ekavian > 0
          ? "ekavian"
          : "ijekavian";
  return { ekavian, ijekavian, reading };
}

/** Reads "ekavica"/"ijekavica" (and Cyrillic or English spellings) from the persona's notes. */
export function expectedDialect(vocabularyNotes: string): Dialect | null {
  const text = cyrillicToLatin(vocabularyNotes).toLowerCase();
  if (/ijekav/.test(text)) return "ijekavian";
  if (/ekav/.test(text)) return "ekavian";
  return null;
}

export function dialectAdherence(
  expected: Dialect | null,
  detection: DialectDetection,
): DialectAdherence {
  if (!expected || detection.reading === "unknown") return "not_assessable";
  return detection.reading === expected ? "match" : "mismatch";
}
