import { describe, expect, it } from "vitest";
import { assessSerbian, isAcceptableLanguage } from "@/lib/serbian/detect";
import { latinToCyrillic } from "@/lib/serbian/latin-to-cyrillic";
import { normalizeForSearch, tokenizeWords } from "@/lib/serbian/normalize";
import { analyzeScript, findEncodingIssues } from "@/lib/serbian/script";
import { findTopicalMarkers } from "@/lib/serbian/topics";
import { cyrillicToLatin } from "@/lib/serbian/transliterate";

describe("cyrillicToLatin", () => {
  it("maps every Serbian Cyrillic letter", () => {
    expect(cyrillicToLatin("абвгдђежзијклљмнњопрстћуфхцчџш")).toBe(
      "abvgdđežzijklljmnnjoprstćufhcčdžš",
    );
  });
  it("capitalises digraphs by context", () => {
    expect(cyrillicToLatin("Љубљана")).toBe("Ljubljana");
    expect(cyrillicToLatin("ЉУБЉАНА")).toBe("LJUBLJANA");
    expect(cyrillicToLatin("Његош")).toBe("Njegoš");
    expect(cyrillicToLatin("Џ")).toBe("Dž");
  });
  it("leaves Latin text, digits, and URLs untouched", () => {
    expect(cyrillicToLatin("RTS 2026 https://rts.rs/ и Београд")).toBe(
      "RTS 2026 https://rts.rs/ i Beograd",
    );
  });
});

describe("latinToCyrillic (controlled template text)", () => {
  it("handles digraphs and capitalisation", () => {
    expect(latinToCyrillic("Ljubljana, Njegoš, džem")).toBe("Љубљана, Његош, џем");
    expect(latinToCyrillic("NJEGOŠ")).toBe("ЊЕГОШ");
  });
  it("respects the exception list for non-digraph letter pairs", () => {
    expect(latinToCyrillic("injekcija")).toBe("инјекција");
    expect(latinToCyrillic("nadživeti")).toBe("надживети");
  });
});

describe("normalizeForSearch", () => {
  it("makes both scripts and diacritic-free typing compare equal", () => {
    expect(normalizeForSearch("Ђорђе из Ниша")).toBe("djordje iz nisa");
    expect(normalizeForSearch("Đorđe iz Niša")).toBe("djordje iz nisa");
    expect(normalizeForSearch("Djordje iz Nisa!")).toBe("djordje iz nisa");
  });
  it("strips foreign combining marks and punctuation", () => {
    expect(normalizeForSearch("Café „Kalemegdan“ — 2026.")).toBe("cafe kalemegdan 2026");
    expect(tokenizeWords("Ajvar, 3 tegle i sarma.")).toEqual(["ajvar", "tegle", "i", "sarma"]);
  });
});

describe("analyzeScript", () => {
  it("recognises single-script text", () => {
    expect(analyzeScript("Dobar dan, Srbijo.").dominant).toBe("Latin");
    expect(analyzeScript("Добар дан, Србијо.").dominant).toBe("Cyrillic");
    expect(analyzeScript("12345 !!!").dominant).toBe("None");
  });
  it("tolerates a small Latin minority inside Cyrillic text", () => {
    const profile = analyzeScript("Купила сам нови iPhone у Београду и задовољна сам.");
    expect(profile.dominant).toBe("Cyrillic");
    expect(profile.minorityShare).toBeLessThan(0.2);
  });
  it("reports genuinely mixed text as Mixed", () => {
    expect(analyzeScript("Ово је pola ћирилица pola latinica").dominant).toBe("Mixed");
  });
  it("separates foreign Cyrillic letters from Serbian ones", () => {
    const profile = analyzeScript("Это русский текст, а не српски.");
    expect(profile.foreignCyrillic).toBeGreaterThan(0);
  });
});

describe("findEncodingIssues", () => {
  it("flags control, bidi, and replacement characters", () => {
    expect(findEncodingIssues("ok")).toContain("control_characters");
    expect(findEncodingIssues("ok‮")).toContain("bidi_or_zero_width");
    expect(findEncodingIssues("ok�")).toContain("replacement_character");
    expect(findEncodingIssues("Sve u redu.\nNovi red je dozvoljen.")).toEqual([]);
  });
});

describe("assessSerbian", () => {
  const acceptable = [
    "Da li neko zna kako se najbolje čuva ajvar preko zime? Moja baka je uvek koristila tegle od kile.",
    "Мислим да је ово питање важније него што изгледа, јер се тиче свих нас у Србији.",
    "Slažem se sa tim, ali bih dodao da podaci iz prošle godine govore nešto drugačije.",
    "Vrijeme u Banjaluci je bilo lijepo, pa smo prošli kroz cijeli grad pješke.",
    "Bio sam u Münchenu kod rođaka i primetio koliko Srba tamo drži male radnje.",
    "Hvala na odgovoru.",
    "Slažem se.",
    "Тачно тако.",
    "Košarka je u Srbiji više od sporta, to zna svako ko je odrastao uz uličnu tablu.",
    "Ne verujem da je to tačno, izvor koji navodiš je star tri godine.",
    "Kad bi neko uporedio cene na pijaci u Nišu i u Beogradu, razlika bi bila očigledna.",
    "Po mom mišljenju, ćirilica i latinica mogu mirno da žive jedna pored druge.",
    "Може ли неко да препоручи добру књигу о историји Војводине?",
    "U Kragujevcu se to radi drugačije nego u Novom Sadu, i to nije loše.",
    "Sarma bez kiselog kupusa nije sarma, i tu nema rasprave.",
    "Voz od Beograda do Novog Sada sada ide za pola sata, što je ozbiljna promena za sve koji putuju na posao.",
    "Koliko košta mesečna karta za gradski prevoz u Beogradu ove godine?",
    "Није лоше, али би могло боље.",
    "Zanima me da li iko zna gde u Subotici mogu da se nađu dobri kolači.",
    "Nakon Sajma knjiga uvek se pitam koliko od kupljenih knjiga zaista pročitam.",
  ];

  it("accepts a representative Serbian corpus in both scripts, including Ijekavian and short replies", () => {
    const failures = acceptable.filter(
      (text) => !isAcceptableLanguage(assessSerbian(text).outcome),
    );
    expect(failures).toEqual([]);
  });

  it("rejects English text firmly", () => {
    expect(
      assessSerbian("This is a comment written in English about the weather.").outcome,
    ).toBe("english");
    expect(assessSerbian("Great point, thanks!").outcome).not.toBe("serbian");
  });

  it("rejects text in alphabets Serbian never uses", () => {
    expect(
      assessSerbian("Это полностью русский текст, который здесь не подходит.").outcome,
    ).toBe("foreign_alphabet");
    expect(assessSerbian("Αυτό είναι ελληνικό κείμενο.").outcome).toBe("foreign_alphabet");
    expect(assessSerbian("これは日本語の文章です。").outcome).toBe("foreign_alphabet");
  });

  it("routes text with several regional-language markers to review rather than publishing", () => {
    const croatianLeaning =
      "Ovaj tjedan smo gledali nogomet na kolodvoru, a glazba je bila iz kazališta.";
    const result = assessSerbian(croatianLeaning);
    expect(result.outcome).toBe("other_language_markers");
    expect(isAcceptableLanguage(result.outcome)).toBe(false);
  });

  it("is uncertain about very short text without any Serbian signal", () => {
    const result = assessSerbian("Ok top");
    expect(isAcceptableLanguage(result.outcome)).toBe(false);
    expect(result.codes).toContain("no_serbian_signal");
  });

  it("documents a known limitation: standard Croatian without marker words passes as likely Serbian", () => {
    // The two languages share most function words; this is why the structured
    // validator exists and why docs/PRODUCT.md lists this limitation.
    const result = assessSerbian("Danas je bio lijep dan i svi smo bili zadovoljni.");
    expect(isAcceptableLanguage(result.outcome)).toBe(true);
  });
});

describe("findTopicalMarkers", () => {
  it("finds inflected stems and phrases in both scripts", () => {
    expect(findTopicalMarkers("Razgovor o ceni ajvara u Srbiji").hit).toBe(true);
    expect(findTopicalMarkers("Шта мислите о новом возу до Новог Сада?").markers).toContain(
      "novog sada",
    );
    expect(findTopicalMarkers("Košarkaška reprezentacija Srbije").markers).toContain("srbij");
  });
  it("does not fire on generic text", () => {
    expect(findTopicalMarkers("Danas je lep dan i svi smo raspoloženi.").hit).toBe(false);
    expect(findTopicalMarkers("Nisu ni oni znali odgovor.").hit).toBe(false);
  });
  it("keeps diacritics so Niš is not confused with 'nisu'", () => {
    expect(findTopicalMarkers("Kao student u Nišu imam dva izbora.").markers).toContain("niš");
    expect(findTopicalMarkers("Као студент у Нишу имам два избора.").markers).toContain("niš");
    expect(findTopicalMarkers("Oni nisu znali, a nisu ni pitali.").hit).toBe(false);
    expect(findTopicalMarkers("Волим Ђердап и Лепенски Вир.").markers).toEqual([
      "lepenski vir",
      "đerdap",
    ]);
  });
});
