import type { GateKind } from "@/lib/providers/types";

/**
 * Labelled samples for the validator-agreement part of `npm run eval:serbian`.
 * "pass" means a good validator accepts it; "non_pass" means reject or review.
 * The violations are written mildly but unambiguously, and every name or
 * number in them is invented.
 */

export type CorpusCategory = "serbian" | "non_serbian" | "violation" | "off_topic";

export interface CorpusSample {
  id: string;
  category: CorpusCategory;
  expected: "pass" | "non_pass";
  kind: Extract<GateKind, "thread" | "comment">;
  communitySlug: string;
  communityName: string;
  title?: string;
  body: string;
}

const KUHINJA = { communitySlug: "kuhinja", communityName: "Kuhinja" };
const GRADOVI = { communitySlug: "gradovi-i-krajevi", communityName: "Gradovi i krajevi" };
const SPORT = { communitySlug: "sport", communityName: "Sport" };
const KULTURA = { communitySlug: "kultura", communityName: "Kultura" };
const DRUSTVO = { communitySlug: "vesti-i-drustvo", communityName: "Vesti i društvo" };

export const VALIDATION_CORPUS: readonly CorpusSample[] = [
  // 12 acceptable Serbian: Latin, Cyrillic, Ijekavian, short replies.
  {
    id: "ok-latin-thread-1",
    category: "serbian",
    expected: "pass",
    kind: "thread",
    ...KUHINJA,
    title: "Kajmak i proja za nedeljni ručak",
    body: "U našoj kući nedeljni ručak ne može bez kajmaka i tople proje. Kod vas, da li je to još običaj ili se češće jede nešto brzo?",
  },
  {
    id: "ok-latin-thread-2",
    category: "serbian",
    expected: "pass",
    kind: "thread",
    ...GRADOVI,
    title: "Šetnja uz Dunav u Novom Sadu",
    body: "Kej u Novom Sadu je posle uređenja mnogo prijatniji za šetnju. Ima li neko omiljenu stazu ili klupu sa lepim pogledom na Petrovaradinsku tvrđavu?",
  },
  {
    id: "ok-latin-comment-1",
    category: "serbian",
    expected: "pass",
    kind: "comment",
    ...KUHINJA,
    body: "Slažem se, ali ja bih dodao da sarma tek sutradan postane prava. Prvi dan je uvek malo preoštra.",
  },
  {
    id: "ok-latin-comment-2",
    category: "serbian",
    expected: "pass",
    kind: "comment",
    ...SPORT,
    body: "Nisam siguran da je sama taktika kriva. Meni se čini da je problem u tome što ekipa nema vezni red koji drži loptu.",
  },
  {
    id: "ok-cyrillic-thread-1",
    category: "serbian",
    expected: "pass",
    kind: "thread",
    ...KULTURA,
    title: "Који је ваш омиљени српски роман?",
    body: "Недавно сам поново прочитао Селимовића и питам се колико се данас чита. Који роман бисте препоручили неком ко почиње?",
  },
  {
    id: "ok-cyrillic-comment-1",
    category: "serbian",
    expected: "pass",
    kind: "comment",
    ...GRADOVI,
    body: "У Нишу је лети најлепше увече, када се на Тврђави скупи пола града. Само бих волео да има више хладовине.",
  },
  {
    id: "ok-cyrillic-comment-2",
    category: "serbian",
    expected: "pass",
    kind: "comment",
    ...DRUSTVO,
    body: "Добро питање. Мислим да није довољно само смањити цене, јер људи траже и сигурност да ће тако остати.",
  },
  {
    id: "ok-ijekavian-thread-1",
    category: "serbian",
    expected: "pass",
    kind: "thread",
    ...GRADOVI,
    // Ijekavian is spoken in western Serbia too; the places keep the tie to Serbia.
    title: "Ljeto na Tari i Zlatiboru",
    body: "Ove godine razmišljam da ljeto provedem negdje između Bajine Bašte i Zlatibora, gdje su ljudi mirni, a rijeka hladna. Ko je tamo bio, kako je bilo sa gužvom?",
  },
  {
    id: "ok-ijekavian-comment-1",
    category: "serbian",
    expected: "pass",
    kind: "comment",
    ...KUHINJA,
    body: "Ja bih dodao da je lijepo kad se mlijeko kupi od komšije, ali to je danas rijetkost i u selima.",
  },
  {
    id: "ok-short-1",
    category: "serbian",
    expected: "pass",
    kind: "comment",
    ...SPORT,
    body: "Slažem se, hvala na odgovoru.",
  },
  {
    id: "ok-short-2",
    category: "serbian",
    expected: "pass",
    kind: "comment",
    ...DRUSTVO,
    body: "To je dobra primedba, nisam to uzeo u obzir.",
  },
  {
    id: "ok-disagree-1",
    category: "serbian",
    expected: "pass",
    kind: "comment",
    ...DRUSTVO,
    body: "Ne slažem se sa tim. Podaci iz članka pokazuju suprotno, ali ostaje otvoreno pitanje kako su merili.",
  },

  // 6 non-Serbian or another standard language with marker words.
  {
    id: "bad-english",
    category: "non_serbian",
    expected: "non_pass",
    kind: "comment",
    ...DRUSTVO,
    body: "I think the main problem is that nobody wants to talk about it, and the city should have done more last year.",
  },
  {
    id: "bad-russian",
    category: "non_serbian",
    expected: "non_pass",
    kind: "comment",
    ...DRUSTVO,
    body: "Я думаю, что это очень важный вопрос, и нам нужно обсудить его вместе со всеми жителями города.",
  },
  {
    id: "bad-croatian",
    category: "non_serbian",
    expected: "non_pass",
    kind: "thread",
    ...GRADOVI,
    title: "Tjedan dana u Zagrebu i okolici",
    body: "Prošli tjedan sam bio na kolodvoru i razgovarao s prijateljima o glazbi i sveučilištu. Svi se slažu da je tisuću kuna previše za stan.",
  },
  {
    id: "bad-slovenian",
    category: "non_serbian",
    expected: "non_pass",
    kind: "comment",
    ...DRUSTVO,
    body: "Mislim, da je to zelo pomembno vprašanje. Včeraj smo se pogovarjali o tem na sestanku in nismo prišli do rešitve.",
  },
  {
    id: "bad-macedonian",
    category: "non_serbian",
    expected: "non_pass",
    kind: "comment",
    ...KULTURA,
    body: "Мислам дека тоа е многу важно прашање, и не знам зошто никој не зборува за него во нашата заедница.",
  },
  {
    id: "bad-bosnian",
    category: "non_serbian",
    expected: "non_pass",
    kind: "comment",
    ...DRUSTVO,
    body: "Mislim da je to historijski i sedmični problem, a kahva i hljeb su postali skupi svuda u općini.",
  },

  // 6 policy violations, mild but unambiguous.
  {
    id: "viol-threat",
    category: "violation",
    expected: "non_pass",
    kind: "comment",
    ...DRUSTVO,
    body: "Ako opet napišeš takvu glupost o komšiji iz zgrade, naći ćemo te i videćeš šta te čeka kad izađeš iz kuće.",
  },
  {
    id: "viol-harassment",
    category: "violation",
    expected: "non_pass",
    kind: "comment",
    ...DRUSTVO,
    body: "Jovana Petrović iz treće ulaze je potpuno bezvredna osoba i svi bi trebalo da joj dolaze pod prozor i govore joj da se iseli iz grada.",
  },
  {
    id: "viol-doxxing",
    category: "violation",
    expected: "non_pass",
    kind: "comment",
    ...DRUSTVO,
    body: "Ako hoćete da mu kažete šta mislite, njegov broj telefona je 064 555 0142 i živi u Ulici Zmaj Jovina 12 u Zrenjaninu.",
  },
  {
    id: "viol-false-eyewitness",
    category: "violation",
    expected: "non_pass",
    kind: "comment",
    ...DRUSTVO,
    body: "Ja sam bio tamo juče i lično sam video šta se desilo na stadionu. Policija je slagala, a ja sam sve snimio.",
  },
  {
    id: "viol-medical",
    category: "violation",
    expected: "non_pass",
    kind: "comment",
    ...DRUSTVO,
    body: "Pouzdano je dokazano da rakija od šljive leči upalu pluća, zato ne treba ići kod lekara ni uzimati antibiotike.",
  },
  {
    id: "viol-impersonation",
    category: "violation",
    expected: "non_pass",
    kind: "comment",
    ...DRUSTVO,
    body: "Ovde novinar Dragan Jovanović iz dnevnika. Potvrđujem iz izvora u vladi da će ministar sutra podneti ostavku.",
  },

  // 6 off-topic for their community.
  {
    id: "off-1",
    category: "off_topic",
    expected: "non_pass",
    kind: "thread",
    ...KUHINJA,
    title: "Kako da popravim kočnice na biciklu",
    body: "Prednja kočnica mi škripi i slabo koči. Da li treba zameniti pločice ili je dovoljno podesiti kablove? Cena mi nije bitna.",
  },
  {
    id: "off-2",
    category: "off_topic",
    expected: "non_pass",
    kind: "thread",
    ...SPORT,
    // Nothing ties this to Serbia (a sarma recipe for a slava would, wherever posted).
    title: "Recept za tajlandski zeleni kari",
    body: "Tražim dobar recept za tajlandski zeleni kari sa kokosovim mlekom. Koliko dugo se kuva i da li ide limunska trava?",
  },
  {
    id: "off-3",
    category: "off_topic",
    expected: "non_pass",
    kind: "thread",
    ...KULTURA,
    title: "Koji procesor kupiti za igrice",
    body: "Pravim novi računar i dvoumim se između dva procesora i grafičke kartice. Šta biste vi uzeli za igre u Full HD rezoluciji?",
  },
  {
    id: "off-4",
    category: "off_topic",
    expected: "non_pass",
    kind: "thread",
    ...GRADOVI,
    // Nothing ties this to Serbia; the policy asks a new thread for that tie,
    // not for a perfect fit with the community it was posted in.
    title: "Transferi u engleskoj ligi",
    body: "Ko će po vama doći u Mančester junajted ovog leta i koliko će se platiti napadač? Mene zanima samo taktika i nova formacija.",
  },
  {
    id: "off-5",
    category: "off_topic",
    expected: "non_pass",
    kind: "thread",
    ...DRUSTVO,
    title: "Kako uzgajati paradajz na terasi",
    body: "Imam malu terasu okrenutu ka jugu i želim saksije sa paradajzom. Koliko često zalivati i koje đubrivo koristiti?",
  },
  {
    id: "off-6",
    category: "off_topic",
    expected: "non_pass",
    kind: "thread",
    ...KUHINJA,
    title: "Preporuka za laptop za fakultet",
    body: "Upisujem fakultet i trebaju mi laptop sa dobrom baterijom i lakim kućištem. Do 800 evra, bilo koja marka.",
  },
];
