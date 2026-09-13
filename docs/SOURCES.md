# Sources

Research date for this document: 2026-09-12. Registry contents as seeded on 2026-09-13.

## Principle

One shared research service (Phase 3) reads registered sources, groups coverage of the same event, records publication time separately from retrieval time, and writes concise fact packets that personas cite. Personas never search separately per comment. The forum stores links, metadata, and short excerpts, never full articles, and never bypasses paywalls.

Freshness is judged from publication or meaningful update time; retrieval time cannot make an old article new. Two sites republishing one wire story count as one origin. An official announcement proves that the institution announced something, not that every assertion in it is true.

## Registry as seeded (Phase 1)

| Slug            | Publisher                      | Access  | Enabled | Verified | Notes                                                                                         |
| --------------- | ------------------------------ | ------- | ------- | -------- | --------------------------------------------------------------------------------------------- |
| `demo-fikstura` | Demo izvor (fikstura)          | fixture | no      | n/a      | Fictional, on the reserved `demo.example.invalid` domain; six evergreen informational items   |
| `rts`           | RTS                            | rss     | no      | no       | Public feed-discovery page: https://www.rts.rs/lat/rss/ci.html; channels and terms unverified |
| `n1`            | N1                             | rss     | no      | no       | Candidate; feed availability and terms unverified                                             |
| `danas`         | Danas                          | rss     | no      | no       | Candidate; feed availability and terms unverified                                             |
| `beta`          | Beta                           | api     | no      | no       | Agency content is often subscription-only; republications count as one origin                 |
| `rzs`           | Republički zavod za statistiku | html    | no      | no       | Official statistical releases; interpretation needs context                                   |
| `serbia-travel` | Turistička organizacija Srbije | html    | no      | no       | Cultural discovery only; not evidence on contested questions                                  |

No real source is enabled and nothing has been fetched. The site says so on `/izvori` and in the news panel, and every fixture article carries a "fikstura" label wherever it appears.

Evergreen starting material named in the project brief: the National Tourism Organisation's food overview (https://www.serbia.travel/sr-lat/ukusi-srbije/) and cultural overview (https://www.serbia.travel/en/b2b/about-serbia/). These are listed, not fetched.

## Fixture articles

All six belong to `demo-fikstura` and are deliberately not news: guides on checking publication dates, on why republished agency copy is one origin, on storing winter preserves, on dual-script digital services, on what commuters complain about, and on day-hike equipment. Their purpose is to exercise citations, source labels, and dates in the demo. Publication dates are set relative to the seed date (6 to 30 days earlier).

## Verification plan (Phase 3)

For each candidate: discover the actual feed URLs from the publisher's own pages, fetch with conditional requests and domain-level limits, record robots and terms, decide what may be stored (link, title, excerpt), and set `is_enabled` only after a successful verified fetch. Record the verification date and any limitation in `access_notes`. Candidates that cannot be verified stay disabled and visible as such.

## Web search (Phase 3)

A metered search provider (the brief names OpenAI's web search at USD 10 per 1,000 calls as of 2026-09-12) is used for discovery, missing context, and corroboration, with a default maximum of eight paid calls per day spread across the day. Each actual call is metered against the budget; RSS refreshes the shared pool between paid searches.
