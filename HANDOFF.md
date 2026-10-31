# Phase 2 handoff: read first, then delete this file

Written 2026-10-31 on the owner's laptop, where Phase 2 was built, to resume the work on the owner's always-on office machine. It holds what the code and the docs do not: the evidence gathered so far, what is left, and the owner's rules. When its contents are recorded in `docs/ACCEPTANCE.md` and `docs/STATE.md` (step 4 below), delete it with `git rm HANDOFF.md` as part of the next commit, and ask the owner before committing.

## Rules from the owner

- Phases are strict. Finish Phase 2, stop at the phase gate, and wait for the owner's explicit go-ahead before any Phase 3 work.
- Ask before every commit or push. The GitHub repository `heyboi227/srpska-agora` is public. Work happens on branch `phase-2-wip`; `main` stays at the Phase 1 state (commit `8258673`) until the owner merges.
- Never print environment variables or `.env` values, in your own commands or in briefs for helper agents: no `env`, `printenv`, `set`, `Get-ChildItem env:`, `node -p process.env`, `cat .env`. Test presence only, for example `node -e "process.loadEnvFile('.env'); console.log(Boolean(process.env.OPENAI_API_KEY))"`. On 2026-10-31 a helper agent dumped the laptop's environment into a transcript, and the owner had to rotate keys.
- The owner adds `OPENAI_API_KEY` to `.env` personally; never ask for it in chat. The owner also starts Docker personally (on Windows, Docker Desktop from the Start menu, never from a shell).
- npm 12 blocks dependency install scripts unless they are pinned in `package.json` `allowScripts`. After `npm install`, run `npm approve-scripts --allow-scripts-pending` and ask the owner before approving anything new. Phase 2 added no dependencies.
- ESLint stays on 9.x. Next.js 16.4 differs from older training data: read the relevant guide under `node_modules/next/dist/docs/` before writing Next code (see `AGENTS.md`).
- Repeated failed admin logins trip a throttle; clear it with `docker exec srpska-agora-db psql -U agora -d srpska_agora -c "delete from login_attempts"`.
- The Dependabot minimatch alert #20 is dismissed on purpose; see the Maintenance section of `docs/STATE.md`.

## Where Phase 2 stands

Implemented, uncommitted until this branch: all seven items of "Next: Phase 2" in `docs/STATE.md`, the three admin views the owner added to the scope (`/admin/raspored`, `/admin/troskovi`, `/admin/poslovi`), 17 fixes from an architect review, and the Serbian evaluation of GPT-5.6 Luna. The implementation plan is recorded in `docs/STATE.md` ("Phase 2 implementation plan"). `docs/ARCHITECTURE.md`, `docs/AGENT_POLICY.md`, `docs/COST_MODEL.md`, `docs/OPERATIONS.md` and `README.md` are already updated for Phase 2; `docs/ACCEPTANCE.md` and the end-of-phase parts of `docs/STATE.md` are not.

Last full results on the laptop (after the review fixes): unit 199 tests, DB 127 tests (about 2.5 minutes), e2e 32 tests (16 per Playwright project), typecheck, lint, format and build clean. After that, the evaluation led to small changes (generation and validation prompt rules, two corpus samples, preset output caps raised from 800/300 to 1,200/800); the unit suite and the costs, jobs, simulation and OpenAI tests passed again, but the full gate has not been re-run since.

## What is left

1. Set up the office machine: fetch and check out `phase-2-wip`; `npm install` (see the npm 12 rule); create `.env` from `.env.example` (database URLs, admin username and password; the owner adds `OPENAI_API_KEY`); with Docker running, `npm run db:up`, then `npm run db:reset` (fresh demo content with current timestamps, migrations 0000 to 0002, admin account from `.env`).
2. Optional, only with the owner's OK: finish the live smoke test (it was stopped after 6 minutes because the owner needed the laptop). Approved total budget USD 1; spent USD 0.112, so about USD 0.88 remain. Procedure used: write a configuration revision with mode `live`, `budget.dailyVariableSpendLimit` 0.25 and the 1,200/800 output caps (a scratch `tsx` script run from the repository root that calls `saveConfigRevision` from `src/lib/config/service.ts`; scratch scripts outside the repository can import `@/…` modules but not bare packages such as `drizzle-orm`), start `npx tsx src/worker/main.ts`, watch `/admin/troskovi` and the worker log for about 30 minutes, then write a revision with `runtime.pauseAllActions` true, stop the worker once no `provider_requests` row is `reserved`, and write the standard preset (mock mode) back. Read-only checks are easiest with `docker exec srpska-agora-db psql …`.
3. Final gate: `npm run verify`, `npm run build` then `npm run test:e2e` (port 3000 free; clear the login throttle first), and `npm run sim:48h` (record its console summary; the caps change alters estimates slightly).
4. Write the evidence and the state: a Phase 2 section in `docs/ACCEPTANCE.md` (automated checks with counts, acceptance criteria 10 to 14 now met with how, the simulation summary, the evaluation and live results below, gaps); in `docs/STATE.md` the phase table (Phase 2 complete with the date), "Phase 2: what was delivered", the decisions below, an outline for Phase 3, and updated unresolved dependencies; the README status line; in `docs/COST_MODEL.md` the measured token averages and the adoption note. Then delete this file.
5. Stop at the phase gate: report to the owner, ask for the spot check of live Serbian samples, the adoption decision, the commit and the merge, and wait for an explicit go-ahead before Phase 3.

## Evidence gathered on the laptop

### Serbian evaluation (`npm run eval:serbian`, reports were in the git-ignored `eval-reports/`)

| Run, effort | Samples | Free checks first / after repair | Script, dialect | Validator on drafts | Corpus agreement | Cost USD |
| ----------- | ------: | -------------------------------: | --------------- | ------------------- | ---------------: | -------: |
| 1, none     |      32 |                   71.9 % / 100 % | 100 %, 15/15    | 30 pass, 2 review   |                — |   0.0343 |
| 1, low      |      12 |                   75.0 % / 100 % | 100 %, 7/7      | 12 pass             |     90.0 % (low) |   0.0153 |
| 2, low      |      32 |                    100 % / 100 % | 100 %, 16/16    | 32 pass             |           93.3 % |   0.0299 |
| 3, low      |       1 |                                — | —               | —                   |            100 % |   0.0120 |

- No incomplete (truncated) responses in any run. Corpus costs are included in each run's total (run 1 corpus USD 0.0093, run 2 USD 0.0104); evaluation total USD 0.1111.
- Run 1: every first-pass failure (12) was `no_topical_marker` on a new thread: the model wrote natural titles without naming anything Serbian, and the prompt stated that rule only in the repair text. The validator rejected two valid Ijekavian samples (one as another language, one demanding evidence for an everyday remark) and passed a thread whose corpus label was wrong under `docs/PRODUCT.md` (topicality is a tie to Serbia, not fit with a community).
- Fixes before run 2: the thread task now requires a visible tie to Serbia; the validation policy says Ijekavian is standard Serbian, asks for evidence only for specific factual claims, and states topicality as in PRODUCT.md; a rule against stock openers ("Slažem se") after two personas opened near-identically; corpus samples `off-2`, `off-4` and `ok-ijekavian-thread-1` rewritten so their labels match the policy. Run 3 checked only the corrected corpus: 100 % agreement, no false passes, no false rejects.
- Token measurements at effort low: thread generation up to 678 output tokens (reasoning up to 105), validation up to 276 (reasoning up to 160); averages in run 2: thread generation 844 input / 433 output (67 reasoning), reply generation 1,182 input (356 cached) / 243 output (64 reasoning), about USD 0.0005 per call. That is why the output caps went to 1,200 and 800.
- Adoption bar (plan step 6): every automated criterion passes at effort `low`. Claude's reading of samples: natural, idiomatic Serbian in both scripts; the Ijekavian persona stays consistent; persona voices come through; civil and specific; no invented facts. The owner's spot check is still pending.

### Live smoke test (stopped early)

- 20:38:45 UTC: configuration revision 2 (mode `live`, daily limit USD 0.25, caps 1,200/800); worker `0.2.0-phase2` started 20:39:00.
- Five ticks (two planned, three idle), all at budget stage normal. Published: one reply and one vote; no skips, no failures.
- OpenAI calls: generation 1,252 input / 208 output tokens (46 reasoning), USD 0.0005, 2.3 s; validation 978 / 100, USD 0.0003, 1.3 s. From plan to published reply: 12 seconds.
- The reply, by "Student iz Niša" (Latin) in the thread "Niš iz ugla studenta: šta se promenilo za pet godina, a šta nikako da se promeni": "Kod Niša mi je baš taj spoj najzanimljiviji: grad se menja tamo gde se promena vidi, dok svakodnevne stvari ostaju tvrdoglavo iste. Može da nikne još deset kafića, ali ako se uveče vraćaš kući kao da rešavaš logističku zagonetku, osećaj napretka brzo splasne. Da li je u drugim gradovima najveći jaz baš između sređenog centra i života na periferiji?"
- Stopped about 20:45 UTC: revision 3 paused all actions, no call was in flight, the worker was stopped, revision 4 restored the standard preset in mock mode.
- Day totals after both: USD 0.1119 spent (evaluation 0.1111, live 0.0008), nothing reserved, no errors or refusals in 259 OpenAI calls.

### Last 48-hour simulation (after the review fixes, before the caps change)

2,522 ticks (358 skipped for a daytime outage), 95.8 s wall clock. Decisions: 585 published, 2 quarantined, 2 skipped (stale 1, paused 1), 1 failed (dead letter). Jobs: 590 sent, 10 retries, 1 dead letter, peak pending 2. Faults: 6 transient, 3 ambiguous, 3 scripted in 192 generation calls; 6 bad first drafts and 1 bad repair (6 repairs paid over 6 actions, 2 quarantined). Day one (limit USD 0.50) spent USD 0.0418; day two (limit lowered to USD 0.06) spent USD 0.0484; stages on day two: normal → reduced 16:05Z → minimal 19:43Z → paused 22:00Z (the owner-cut event at hour 42) → normal at the next UTC day. Diversity: 10/10 communities got new threads (top 16.7 %), 16/16 personas commented (top 12.2 %). All 16 checks passed, among them: daily maxima, persona limits, cooldowns, pair chains (longest 4 of 4), thread contributions, night rate (1.4 % of the day rate), no catch-up (23 planned in the first hour back against a bound of 58), pause, spend within limits (highest 80.6 %), budget stages, queue bounds, no duplicates (the duplicate delivery ended `already_done`), retention, one repair per action, quarantine publishes nothing.

## Decisions taken during implementation (for `docs/STATE.md`)

- The `scheduler` configuration section uses zod `prefault` defaults, so revisions stored before Phase 2 still parse.
- Money is integer micro-USD; USD per 1M tokens equals micro-USD per token. Budget windows follow UTC; content maxima follow the Belgrade day; the worker runs on database time.
- The cost gateway wraps the providers; providers that are not configured bypass it, so "not configured" is never reported as a budget refusal. Estimates: request JSON length ÷ 2 plus 2,000 tokens; output equals `max_output_tokens`.
- Stages: normal above 40 % of the daily limit remaining, reduced above 20 %, minimal above 5 %, paused below that or when one more action no longer fits (twice the average recent reservation).
- Ambiguous calls count in full; open reservations become ambiguous after 15 minutes and settle at their estimate after an hour.
- Jobs retry transient validator failures with the stored draft; admin and moderation paths still quarantine. At most one paid repair per action key, also across retries. Validator rejections are quarantined without a repair.
- Moderation hides never depend on a budget or a validator, ignore soft codes, and invalidate the thread's summaries (a summary becomes due again at once, since comment counts do not drop on a hide).
- Votes make no model call, continue during a paid pause, and are −1 with a seeded 15 % chance when the target already scores 3 or more.
- Scheduler: weights in code, an idle option worth 0.8, a draw among the top 8, the tick guard at half a period, one in-flight reply per target, a burst guard, no catch-up.
- pg-boss: the `exclusive` policy for action queues; expiry 300 s for content jobs and 30 s for votes; content queues at concurrency 1 behind one shared semaphore of `maxConcurrentPaidCalls`; backoff from 30 s to 15 minutes; dead letters mark the decision and the action failed; a job that outlives its expiry still records its true outcome.
- Context: the thread's opening post (1,000 characters) goes to replies and summaries; the text a revision rewrites is sent whole.
- OpenAI adapter: Responses API over `fetch`, `store: false`, strict JSON schemas, no `temperature`, reasoning effort `low` by default, output caps 1,200/800.
- Simulation: an owner-cut event at hour 42 shows the paused stage, because spending in the minimal stage slows to a trickle on its own; determinism is compared on counts only, because services use random UUIDs.
- The mock generator writes entirely in the persona's script, adds a plain topical anchor to threads that name nothing Serbian, and writes gender-neutral memory notes.

## Known gaps and follow-ups

- Full run determinism would need injectable id generation.
- The worker's graceful stop was not exercised on Windows (no Ctrl+C reaches a background process from an automation shell).
- A reused draft carries no memory note; the persona then records no memory for that one action.
- Fresh evidence for new threads stays zero until Phase 3 links articles to communities.
- Active hours are not re-checked when a job runs (jobs run within minutes of planning); the paid-pause exemption covers every admin-origin call (only moderation makes such calls today).
- The owner still has to rotate the keys exposed on 2026-10-31.

## Draft outline for Phase 3 ("Real news")

Source registry activation (terms and robots reviewed per publisher, RSS first); an SSRF-safe fetcher (host allow-list, size and time limits, conditional GET, excerpts only, the 256 MiB fetch cache); RSS polling with deduplication by canonical URL and content hash and separate publication, update, retrieval and event times; story clusters and fact packets that link articles to communities (which turns on fresh evidence for new threads); one shared research service with paid web search inside `maxPaidSearchCallsPerDay`, metered by the gateway; freshness rules so stale news never looks fresh, and an honest news panel; per-source failure states; prompt-injection hygiene for fetched text; tests for the fetcher, deduplication, freshness and clustering, plus a simulated news day. Acceptance criteria 7, 8, 9 and 17.
