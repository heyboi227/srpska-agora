/**
 * Word lists for the cheap language heuristics. Everything is stored in the
 * normalised form produced by normalizeForSearch (lower case, Latin, no
 * diacritics), so Cyrillic input and diacritic-free typing both match.
 *
 * These lists decide only the inexpensive first pass. They cannot separate
 * Serbian from closely related languages with certainty; see docs/PRODUCT.md
 * for the documented limitations and the review outcome used for doubt.
 */

const words = (list: string): ReadonlySet<string> =>
  new Set(list.split(/\s+/).filter((w) => w.length > 0));

/** Serbian function words and very common forms, Ekavian and Ijekavian alike. */
export const SERBIAN_FUNCTION_WORDS = words(`
i u na je se da za su od sa ne o kao ali ili to sto koji koja koje kojih kome kojim
ovo ova ovaj ove ovog ovom taj ta te ti tu tim tom toga tog onaj ona ono oni one
biti bio bila bilo bili bile ce cu cemo cete bi bih bismo biste smo ste sam si jesam jesi
jeste jesu nije nisu nisam nismo niste ima imaju imao imala imali nema nemam nemaju
samo vec jos kad kada gde gdje zasto jer ako pa ni niti li do po pri kroz prema izmedju
bez zbog kod iz mi vi ja on mu joj ih im nas vas ga ju me nam vam njega njemu njoj nju
njih njima moj moja moje mog mojoj tvoj tvoja tvoje svoj svoja svoje svog svojoj nas
nasa nase naseg nasoj vas vasa vase njihov njihova njihovo ovde ovdje tamo sada sad onda
uvek uvijek nikad nikada moze mogu mozemo mozete mogao mogla mogli treba trebalo mora
moram moramo hoce hocu hocemo nece necu necemo bice vise manje mnogo malo vrlo veoma
dobro dobar dobra kako koliko sta ko neko nesto nista niko svako sve svi sva svaki svakog
jedan jedna jedno jednog jednom dva dve dvije tri cetiri pet cega cime zato dakle medjutim
ipak takodje opet evo eto eno hvala molim danas sutra juce jucer godine godina godinu
posle poslije pre prije dok tek cak bas valjda mozda sigurno naravno upravo odmah zatim
potom nego oko preko ispod iznad ispred iza pored uz niz pod nad medju protiv radi umesto
umjesto osim sem tokom krajem pocetkom ovih onih tih svih svim nekih nekog nekoj kojoj
kojeg kojem kojom ciji cija cije rekao rekla kaze kazu mislim mislis misli smatram
slazem slazes verujem vjerujem vidim vidis znam znas zna znamo zapravo inace stvarno
mozes mozemo trebalo bilo bi nesto nekako negde negdje nekad nekada uopste uopce
`);

/** English function words; two or more of these without Serbian signal means English. */
export const ENGLISH_FUNCTION_WORDS = words(`
the and is are of to in that this with for was were be have has it on as at by from not
but or you your we they he she will would can could should there their what which who
when where how about into than then also been being its our out up if so no yes do does
did just more most some any all one two very really think know like get got make made
because while these those them his her my me an
`);

/**
 * Markers of closely related languages written in the same script. Ijekavian
 * forms are deliberately absent: Ijekavian Serbian is valid content here. These
 * words only lower confidence and route the text to review; they never prove
 * a text is not Serbian.
 */
export const REGIONAL_LANGUAGE_MARKERS = words(`
tko netko nitko tjedan tjedna tjedno glazba glazbe glazbu tisuca tisuce tisucu kolodvor
kolodvora zrakoplov zrakoplova sveuciliste sveucilista povijest povijesti nogomet nogometa
kazaliste kazalista tvrtka tvrtke tvrtku ozujak ozujka travanj travnja svibanj svibnja
lipanj lipnja srpanj srpnja kolovoz kolovoza rujan rujna listopad listopada studeni
studenog prosinac prosinca sijecanj sijecnja veljaca veljace gospodarstvo gospodarstva
obitelj obitelji otok otoka tocka tocke vlak vlaka vlakom juha juhe mrkva mrkve rajcica
rajcice tajnik tajnika duznosnik duznosnika izvjesce izvjesca casnik casnika znanost
znanosti uvjet uvjeti uvjete sustav sustava sustavu tijekom glede ravnatelj ravnatelja
promidzba promidzbe zemljopis zemljopisa tisak tiska tisku
deka ovaa nie vie tie sekoj sekoja mnogu sakam sakame imame blagodaram
tudi lahko ampak kjer zdaj vendar nekaj nic vse
`);
