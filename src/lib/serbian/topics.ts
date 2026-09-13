import { cyrillicToLatin } from "./transliterate";

/**
 * Topical markers: word stems and phrases that tie a text to Serbia. This is a
 * cheap admission check for new threads, not a judgement of relevance. It
 * cannot notice a generic story with "u Srbiji" appended; the structured
 * validator (Phase 2) is responsible for that. Replies inherit their thread's
 * topical status and are not checked against this list.
 *
 * Matching keeps Serbian diacritics (unlike search normalisation) because
 * folding creates collisions: "Nišu" would fold to "nisu" ("are not"). Cyrillic
 * is transliterated first, so both scripts match the same stems. Latin text
 * typed without diacritics matches only the stems that have none.
 *
 * Stems are matched as token prefixes so Serbian inflection (Srbija, Srbije,
 * Srbiji, Srbijom) needs one entry. Phrases are matched against the
 * single-spaced text with a word boundary at the start.
 */

const STEMS: readonly string[] = [
  "srbij",
  "srpsk",
  "srbin",
  "srbi",
  "srpkinj",
  "beograd",
  "beograđ",
  "vojvodin",
  "vojvođan",
  "šumadij",
  "kragujev",
  "subotic",
  "subotič",
  "zrenjanin",
  "pančev",
  "čačak",
  "čačan",
  "kraljev",
  "užic",
  "užič",
  "valjev",
  "šabac",
  "šapč",
  "smederev",
  "leskov",
  "vranj",
  "pirot",
  "zaječar",
  "sombor",
  "kikind",
  "vršac",
  "vršč",
  "loznic",
  "loznič",
  "novopazar",
  "prijepolj",
  "kopaonik",
  "zlatibor",
  "đerdap",
  "dunav",
  "morav",
  "drin",
  "fruškogor",
  "dinar",
  "partizan",
  "delij",
  "grobar",
  "sarm",
  "ajvar",
  "kajmak",
  "ćevap",
  "pljeskavic",
  "rakij",
  "šljivovic",
  "kafan",
  "gibanic",
  "burek",
  "proj",
  "slav",
  "đurđevdan",
  "vidovdan",
  "kolo",
  "gusl",
  "tesl",
  "pupin",
  "karadžić",
  "ćirilic",
  "ćirilič",
  "latinic",
  "latinič",
  "ekavic",
  "ijekavic",
  "jugoslav",
  "dijaspor",
  "gastarbajter",
  "banat",
  "bačk",
  "srem",
  "kosov",
  "metohij",
  "sandžak",
  "egzit",
  "guč",
  "rts",
  "skupštin",
  "narodn",
  "opštin",
  "eps",
  "beovoz",
  "bgvoz",
  "gsp",
  "železnic",
  "ibarsk",
  "tar",
  "niš",
  "krušev",
  "jagodin",
  "požarev",
  "vrnjačk",
  "sokobanj",
  "palić",
];

const PHRASES: readonly string[] = [
  "novi sad",
  "novog sada",
  "novom sadu",
  "novim sadom",
  "crvena zvezda",
  "crvene zvezde",
  "crvenoj zvezdi",
  "sajam knjiga",
  "sajmu knjiga",
  "sajma knjiga",
  "nikola tesla",
  "vuk karadžić",
  "fruška gora",
  "fruškoj gori",
  "fruške gore",
  "južna morava",
  "zapadna morava",
  "velika morava",
  "ibarska magistrala",
  "matica srpska",
  "narodno pozorište",
  "narodna biblioteka",
  "sava centar",
  "ada ciganlija",
  "stari grad",
  "kalemegdan",
  "skadarlij",
  "zemun",
  "novi beograd",
  "petrovaradin",
  "lepenski vir",
];

/** Stems short enough to collide with ordinary words; matched only as whole tokens. */
const EXACT_ONLY = new Set([
  "tar",
  "eps",
  "gsp",
  "rts",
  "guč",
  "bačk",
  "srem",
  "slav",
  "proj",
  "kolo",
  "drin",
]);

export interface TopicalCheck {
  hit: boolean;
  markers: string[];
}

/** Lower-case Latin with Serbian diacritics kept; punctuation becomes spaces. */
export function normalizeForTopics(input: string): string {
  return cyrillicToLatin(input.normalize("NFC"))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function findTopicalMarkers(text: string): TopicalCheck {
  const normalized = normalizeForTopics(text);
  if (normalized.length === 0) return { hit: false, markers: [] };
  const tokens = normalized.split(" ");
  const markers = new Set<string>();

  for (const token of tokens) {
    for (const stem of STEMS) {
      if (EXACT_ONLY.has(stem)) {
        // Whole token or the common feminine nominative (Tara, Guča, Drina, Bačka).
        if (token === stem || token === `${stem}a`) markers.add(stem);
      } else if (token.startsWith(stem)) {
        markers.add(stem);
      }
    }
  }

  const padded = ` ${normalized} `;
  for (const phrase of PHRASES) {
    if (padded.includes(` ${phrase}`)) markers.add(phrase);
  }

  return { hit: markers.size > 0, markers: [...markers].sort() };
}
