export interface ArticleFixture {
  key: string;
  title: string;
  summary: string;
  canonicalUrl: string;
  publishedDaysAgo: number;
}

export interface SourceFixture {
  slug: string;
  publisherName: string;
  websiteUrl: string;
  feedUrl: string | null;
  accessKind: "rss" | "api" | "html" | "fixture";
  category: string;
  language: string;
  ownershipGroup: string | null;
  isEnabled: boolean;
  isFixture: boolean;
  accessNotes: string;
  articles: ArticleFixture[];
}

/**
 * The source registry at seed time. Real publishers are listed as candidates:
 * disabled, unverified, with nothing fetched. The only articles in the demo
 * come from an explicitly fictional publisher on the reserved .invalid domain,
 * so nothing here can be mistaken for real news.
 */
export const SOURCE_FIXTURES: SourceFixture[] = [
  {
    slug: "demo-fikstura",
    publisherName: "Demo izvor (fikstura)",
    websiteUrl: "https://demo.example.invalid/",
    feedUrl: null,
    accessKind: "fixture",
    category: "demo",
    language: "sr",
    ownershipGroup: null,
    isEnabled: false,
    isFixture: true,
    accessNotes:
      "Izmišljeni izvor za lokalnu demonstraciju. Članci nisu vesti i ne opisuju stvarne događaje; služe da pokažu kako izgledaju citati i oznake izvora.",
    articles: [
      {
        key: "demo-datum",
        title: "[Demo] Vodič: kako se proverava datum objave članka",
        summary:
          "Datum objave se čita iz samog članka i iz metapodataka stranice, a ne iz trenutka kada je članak pronađen. Kada se datumi razlikuju, stariji se uzima kao datum prve objave, a noviji kao dopuna.",
        canonicalUrl: "https://demo.example.invalid/vodic/datum-objave",
        publishedDaysAgo: 21,
      },
      {
        key: "demo-agencije",
        title: "[Demo] Objašnjenje: zašto dva sajta sa istom vešću nisu dva izvora",
        summary:
          "Kada više medija prenese isti agencijski izveštaj, poreklo informacije je jedno. Nezavisna potvrda postoji tek kada drugi izvor dođe do podatka sopstvenim putem.",
        canonicalUrl: "https://demo.example.invalid/objasnjenje/agencijske-vesti",
        publishedDaysAgo: 18,
      },
      {
        key: "demo-ajvar",
        title: "[Demo] Pregled: uobičajeni načini čuvanja zimnice u domaćinstvima",
        summary:
          "Tamna i hladna ostava, dobro zatvorene tegle i redovna kontrola poklopaca navode se kao najčešće preporuke za čuvanje ajvara i druge zimnice preko zime.",
        canonicalUrl: "https://demo.example.invalid/pregled/cuvanje-zimnice",
        publishedDaysAgo: 30,
      },
      {
        key: "demo-pisma",
        title:
          "[Demo] Beleška: ravnopravna upotreba ćirilice i latinice u digitalnim servisima",
        summary:
          "Digitalni servisi koji nude oba pisma obično čuvaju izvorni tekst i prikazuju izabrano pismo, umesto da menjaju sadržaj. Pretraga treba da pronađe isti pojam nezavisno od pisma.",
        canonicalUrl: "https://demo.example.invalid/beleska/dva-pisma",
        publishedDaysAgo: 12,
      },
      {
        key: "demo-prevoz",
        title: "[Demo] Zapažanje: šta putnici najčešće zameraju gradskom prevozu",
        summary:
          "U anketama o gradskom prevozu putnici najčešće pominju nepredvidive intervale, gužvu u vršnim satima i nedostatak informacija na stajalištima, dok cena karte dolazi tek posle toga.",
        canonicalUrl: "https://demo.example.invalid/zapazanje/gradski-prevoz",
        publishedDaysAgo: 9,
      },
      {
        key: "demo-planine",
        title: "[Demo] Podsetnik: osnovna oprema za jednodnevno planinarenje",
        summary:
          "Za jednodnevni izlet na planinama Srbije preporučuje se dovoljno vode, slojevita odeća, karta ili preuzeta ruta i najava izleta nekome ko ostaje u dolini.",
        canonicalUrl: "https://demo.example.invalid/podsetnik/planinarska-oprema",
        publishedDaysAgo: 6,
      },
    ],
  },
  {
    slug: "rts",
    publisherName: "RTS",
    websiteUrl: "https://www.rts.rs/",
    feedUrl: null,
    accessKind: "rss",
    category: "vesti",
    language: "sr",
    ownershipGroup: "javni medijski servis",
    isEnabled: false,
    isFixture: false,
    accessNotes:
      "Kandidat. Javna stranica za otkrivanje RSS kanala: https://www.rts.rs/lat/rss/ci.html. Konkretni kanali i uslovi korišćenja još nisu verifikovani; verifikacija je deo faze 3.",
    articles: [],
  },
  {
    slug: "n1",
    publisherName: "N1",
    websiteUrl: "https://n1info.rs/",
    feedUrl: null,
    accessKind: "rss",
    category: "vesti",
    language: "sr",
    ownershipGroup: null,
    isEnabled: false,
    isFixture: false,
    accessNotes: "Kandidat. Dostupnost RSS kanala i uslovi korišćenja nisu verifikovani.",
    articles: [],
  },
  {
    slug: "danas",
    publisherName: "Danas",
    websiteUrl: "https://www.danas.rs/",
    feedUrl: null,
    accessKind: "rss",
    category: "vesti",
    language: "sr",
    ownershipGroup: null,
    isEnabled: false,
    isFixture: false,
    accessNotes: "Kandidat. Dostupnost RSS kanala i uslovi korišćenja nisu verifikovani.",
    articles: [],
  },
  {
    slug: "beta",
    publisherName: "Beta",
    websiteUrl: "https://beta.rs/",
    feedUrl: null,
    accessKind: "api",
    category: "agencija",
    language: "sr",
    ownershipGroup: "novinska agencija",
    isEnabled: false,
    isFixture: false,
    accessNotes:
      "Kandidat. Agencijski sadržaj je često pod pretplatom; više medija koji prenose isti izveštaj računa se kao jedno poreklo.",
    articles: [],
  },
  {
    slug: "rzs",
    publisherName: "Republički zavod za statistiku",
    websiteUrl: "https://www.stat.gov.rs/",
    feedUrl: null,
    accessKind: "html",
    category: "statistika",
    language: "sr",
    ownershipGroup: "državna institucija",
    isEnabled: false,
    isFixture: false,
    accessNotes:
      "Kandidat za zvanična statistička saopštenja. Saopštenje potvrđuje da je institucija nešto objavila; tumačenja traže dodatni kontekst.",
    articles: [],
  },
  {
    slug: "serbia-travel",
    publisherName: "Turistička organizacija Srbije",
    websiteUrl: "https://www.serbia.travel/",
    feedUrl: null,
    accessKind: "html",
    category: "kultura-i-turizam",
    language: "sr",
    ownershipGroup: "državna institucija",
    isEnabled: false,
    isFixture: false,
    accessNotes:
      "Kandidat za kulturna i turistička otkrića (jela, destinacije, običaji). Turistički materijal nije dokaz o spornim političkim pitanjima.",
    articles: [],
  },
];
