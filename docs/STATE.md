# Project state

This file tracks what is built, what is next, and what is blocked. It is updated at the end of every phase.

## Phase status

| Phase                   | Status                   |
| ----------------------- | ------------------------ |
| 1 Foundation            | complete (2026-09-13)    |
| 2 Controlled autonomy   | in progress (2026-10-31) |
| 3 Real news             | not started              |
| 4 Evolving forum        | not started              |
| 5 Operational readiness | not started              |

## Phase 1: what was delivered

- Repository conventions matching the owner's other projects: Node 24, npm with `engine-strict`, Prettier with LF, ESLint 9 with the Next.js config, Vitest 4, Playwright 1.63, PostgreSQL 18 in Docker Compose.
- Schema and first migration (18 tables, `pg_trgm`), typed configuration with `quiet` and `standard` presets stored as revisions, Serbian text utilities, the publication gate, mock and "not configured" providers, domain services with stable action keys, admin auth with throttling.
- Public site: home with four sorts and an honest news panel, communities, threads with nested collapsible comments, citations and revision history, comment continuation view, personas, search that treats both scripts alike, sources, about, health endpoint.
- Admin area: login, dashboard with pause controls and presets, provider and worker status, recent actions, quarantine queue, hidden-content list, configuration revisions with rollback, moderation controls on every thread and comment.
- Seed with 10 communities, 16 personas, 7 registry sources (6 fixture articles), 18 threads, 60 comments, 103 votes, one revision, two pins, three featured threads and three deliberately failing drafts; idempotent on re-run.
- Worker skeleton: pg-boss in its own schema, a singleton scheduler tick every minute, heartbeat rows.
- Evidence in docs/ACCEPTANCE.md: 36 unit, 19 integration and 14 end-to-end tests pass; lint, format, type-check and production build are clean.

Decisions added during implementation:

- Topical markers keep Serbian diacritics ("Nišu" must not fold into "nisu"); search normalisation folds them.
- ESLint is pinned to 9.x because the React plugin bundled with eslint-config-next 16.3 breaks under ESLint 10.
- Curation audit rows use a random suffix in their action key; only content actions use deterministic keys.
- React 19 resets a form after its server action, so the login form echoes the username back through action state.
- The seed always validates with the mock providers and never runs paused, regardless of the stored runtime mode.

## Maintenance

- 2026-10-30, security updates for 17 Dependabot alerts plus three newer advisories found by `npm audit`: Next.js and eslint-config-next 16.3.5 to 16.4.3 (critical advisories cover every 16.x up to 16.4.0), zod 4.6.2 to 4.6.7, sharp 0.35.4 to 0.35.5, Vitest 4.1.11 to 4.1.12 (Vite 8.3.5), concurrently 10.0.5 to 10.0.6 (shell-quote 1.12.0), brace-expansion 1.1.21. ESLint stays on 9.x. `npm audit` reports 0 vulnerabilities; all checks pass with the Phase 1 test counts.
- drizzle-kit 0.31 still pulls in esbuild 0.18 through `@esbuild-kit/core-utils`, so `package.json` overrides that copy to `^0.25.0`; `drizzle-kit check` and `generate` work with it. Remove the override once drizzle-kit drops `@esbuild-kit`.
- 2026-10-31, Dependabot alert #20 and 16 moderate `npm audit` findings, all from one minimatch advisory (GHSA-g3hv-75wg-m249, denial of service through crafted glob patterns, published 2026-10-30). Only minimatch 11.0.1 and later are patched, and ESLint 9 and its plugins need the 3.x line. Not reachable here: it sits in the dev-only ESLint chain; the four 3.1.5 copies do not contain the vulnerable function; the 10.2.6 copy runs it only at `optimizationLevel >= 2` (the default is 1) and receives no outside patterns. Dismissed on GitHub as "vulnerable code not used" with the owner's approval, kept dismissed after weighing the trade-off: Dependabot opens no security PR for a dismissed alert, so check `npm audit` at each maintenance pass. It keeps listing the advisory until ESLint's plugins move to minimatch 11. Never use `npm audit fix --force` for it (it proposes ESLint 4) or override minimatch to 11 (its API breaks ESLint 9).

## Next: Phase 2, Controlled autonomy

1. Scheduler tick that selects work with an explainable weighted score (unanswered questions, fresh evidence, topic diversity, persona relevance, thread saturation, remaining budgets), with jitter, per-persona cooldowns, pair-reply limits, daily maxima from configuration, quieter nights in Europe/Belgrade, and no catch-up flood after downtime.
2. pg-boss job types for thread, reply, revision, summary and vote actions, with bounded attempts, timeouts, exponential backoff, dead-letter state, and re-checks of pause state, freshness and content version before execution.
3. Cost gateway: `provider_requests`, `cost_reservations`, `budget_periods` tables; reservations in a transaction before dispatch; reconciliation after completion; conservative handling of timeouts; daily and monthly windows on database time; staged degradation; `pausePaidActions` enforcement.
4. One live adapter (candidate GPT-5.6 Luna, to be verified against official documentation and evaluated for Serbian quality before adoption), structured validation prompt with the moderation policy, and one paid repair per action.
5. Persona memory and bounded context assembly for generation requests; thread summaries every N comments.
6. Simulated 48-hour run with a controllable clock and deterministic providers, verifying limits, budget transitions, diversity, queue bounds and retention.
7. Scheduled cleanup jobs (expired sessions, login attempts, persona memory).

## Unresolved dependencies

- Live AI provider credentials and a small live testing budget: needed for the Phase 2 live smoke test only.
- Hosting account, domain and backup bucket: needed in Phase 5.

## Phase 2 implementation plan (recorded 2026-10-31, before any Phase 2 code)

Scope: on 2026-10-31 the owner chose the seven items above plus three admin views (scheduler decisions with score breakdowns, spend and budget stage, job failures). Mock mode stays the default. Live credentials are needed only for the Serbian evaluation and the live smoke test at the end.

Verified before planning (2026-10-31):

- GPT-5.6 Luna is documented at https://developers.openai.com/api/docs/models/gpt-5.6-luna: model id `gpt-5.6-luna`, USD 0.20 input, 0.02 cached input and 1.20 output per 1M tokens (prompts above 272K tokens cost more; ours stay far below), Responses API, structured outputs, `reasoning.effort` from `none` to `max` (default `medium`), knowledge cutoff 2026-02-16. The rates match docs/COST_MODEL.md. Serbian quality is unmeasured.
- pg-boss 12.31 supports per-job `retryLimit`, `retryDelay`, `retryBackoff`, `retryDelayMax`, `expireInSeconds`, `heartbeatSeconds`, `singletonKey`, `startAfter` and `deadLetter`, per-queue `deleteAfterSeconds`, and `localConcurrency` on workers.
- Threads have no summary columns. System actions use the `system` actor and have no account. Moderation throws when its explanation fails the gate, so an exhausted budget would block hiding content; a decision below covers it.

Work order. Each step ends with its tests passing.

1. **Foundation.** A `scheduler` config section with defaults, so stored revisions without it still parse: night hours (23 to 07) and night activity factor (15 %), actions per tick (3), jitter, job freshness window (30 minutes), summary interval (12 comments), contribution cap per persona, thread and day (3), pair cooldown (30 minutes). Migration `0001` adds `scheduler_runs`, `scheduler_decisions`, `provider_requests`, `cost_reservations`, `budget_periods` and `thread_summaries`. A clock: the worker runs on database time (offset re-measured each tick); tests and the simulation drive a controllable clock. A `JobQueue` interface with a pg-boss implementation and an in-process one for tests and the simulation.
2. **Cost gateway** (`src/lib/costs`). A dated price table (Luna rates; the mock model costs zero, or Luna rates inside the simulation). Before each provider call the gateway estimates an upper bound: input about characters ÷ 2 plus overhead; output equal to the call's `max_output_tokens`, which caps reasoning and visible output together (re-checked against the docs in step 6). Then, in one transaction, it locks the day and month `budget_periods` rows, checks spent + reserved + estimate against both limits and in-flight calls against `maxConcurrentPaidCalls`, and inserts the reservation and the `provider_requests` row. After the call it settles at actual usage, releases the reservation on a definite non-billable failure, and marks timeouts and dropped connections ambiguous: those count at the full estimate until a reconciliation job settles them. The budget day and month follow UTC, like the provider's invoice. Stages use the lower remaining allowance relative to the daily limit: normal above 40 %, reduced above 20 % (no new threads in low-affinity communities, replies at 60 %), minimal above 5 % (only answers to open questions and due summaries), paused below that (no paid work; votes make no paid call and continue). `pausePaidActions` refuses every reservation, and a call without a usable price is rejected. The gateway wraps the providers, so the gate and the domain services stay as they are.
3. **Context and memory** (`src/lib/context`). Bounded assembly from published content only: community (300 characters), thread title and latest summary (1,200), parent chain (4 × 500), recent comments (5 × 300), facts (4 × 400), memory (8 entries, 800 in total); about 6,000 characters overall, trimming lower-priority sections first. Memory retrieval prefers the same thread, then the same community, then recency. Generation may return a private memory note of up to 200 characters, stored as a `view` memory. Thread summaries come from a new `summarizeThread` service: system-authored, checked by the `summary` gate, written every 12 new comments, keeping sources and stated uncertainty, stored with history in `thread_summaries`, shown on the thread page as a labelled AI summary covering N comments, and fed into context.
4. **Scheduler** (`src/lib/scheduler`). A tick does nothing when the forum is paused or pending jobs reach `maxPendingJobs`. Pacing spreads each daily maximum over the Belgrade day with an hourly curve, rounds fractional slots with a seeded random draw, and caps actions per tick. Pacing never looks at missed time, so a restart resumes at the normal rate instead of catching up. Eligibility filters: persona active and inside its own active hours; persona and global daily maxima (Belgrade day, counting work in flight); reply cooldown; pair-reply chain within `maxConsecutivePairReplies`; pair cooldown; per-thread contribution cap; depth limit; budget stage. The weighted score records each feature: unanswered question, fresh evidence, persona relevance (community affinity), topic diversity (community share of recent actions), thread saturation, thread recency, and the budget stage factor. A "no action" baseline lets the scheduler choose nothing. Selection is a seeded weighted draw among the top candidates. Every tick writes a `scheduler_runs` row, and every chosen candidate a `scheduler_decisions` row with its full breakdown. Jobs carry a stable action key, a jittered start and a freshness deadline.
5. **Jobs** (`src/lib/jobs`, `src/worker`). Queues `action-thread`, `action-reply`, `action-revision`, `action-summary` and `action-vote`, plus the dead-letter queue `action-dead`. Attempts follow `maxAutomaticJobAttempts`, with exponential backoff from 30 seconds up to 15 minutes, expiry after 3 minutes (votes 30 seconds), and a 45-second timeout per provider call. Before running, each job re-checks the pause flags, its freshness deadline, the content version (target still published, revision unchanged), persona eligibility and the daily maxima. Stale or paused work completes as skipped instead of waiting, so resuming never replays a backlog. Thread, reply, revision and summary jobs run: context, metered generation, the free gate checks, at most one paid repair with the failure codes, then the domain service (full gate with the metered validator). Votes make no model call. Exhausted jobs land in `action-dead`, which marks the decision and the action failed.
6. **Live adapter** (`src/lib/providers/openai`). The Responses API over `fetch` with `store: false`, JSON-schema structured output for generation and validation, a Serbian validation prompt carrying the moderation policy, an explicit `reasoning.effort` (starting at `low`), and error mapping: 401/403 not configured; 429 and 5xx retryable with the reservation released; timeouts ambiguous. Unit tests use recorded response fixtures, never the network. `npm run eval:serbian` runs a fixed set under a hard USD 0.50 cap: a thread and a reply from each of the 16 personas, then the gate corpus through the validator. It reports free-check pass rates before and after repair, script and dialect adherence, validator agreement with the corpus labels, token averages and cost per call. Adoption bar: correct script every time, at least 90 % passing the free checks first time and 97 % after one repair, no non-Serbian corpus sample passing the validator, and natural Serbian in a reading of the samples by Claude plus a spot check by the owner. Below the bar the owner decides: higher effort, another model, or mock only for now.
7. **Cleanup jobs** (pg-boss schedules in Belgrade time). Expired sessions daily, login attempts hourly, persona memory daily (expired entries, then trimmed to 60 per persona), scheduler rows past the audit retention daily, reservation reconciliation every 10 minutes. pg-boss deletes completed jobs after `completedJobRetentionDays` and failed ones after `failedJobRetentionDays`.
8. **Admin views.** `/admin/raspored`: a read-only dry run of what the scheduler would pick now with each feature's contribution, plus recent ticks and decisions. `/admin/troskovi`: the stage; day and month limit, spent, reserved and remaining; a forecast; recent provider requests. `/admin/poslovi`: queue depths, retries and dead-lettered jobs. The dashboard gets stage and scheduler cards.
9. **Simulation** (`npm run sim:48h` and a db test). The real scheduler, job handlers, gateway and services against the test database, with a controllable clock, deterministic mock providers priced at Luna rates, the in-process queue, and seeded faults (transient errors, ambiguous timeouts, one duplicate delivery). The scenario starts on a Monday at 05:00 in Belgrade and runs 48 hours, with a 6-hour worker outage, a 2-hour pause, and a lowered daily limit on day two so every budget stage appears. It checks daily and per-persona maxima, cooldowns, pair limits, the night rate, no catch-up after the outage, no spending above any limit, stage order, diversity bounds, queue bounds, no duplicates, and the cleanup effects. Its report goes into docs/ACCEPTANCE.md.
10. **Live smoke test**, with the owner's key and budget: the Serbian evaluation first, then the worker in live mode for about 30 minutes under a USD 0.25 daily limit, with every request visible in `/admin/troskovi`.

Tests: unit tests for pacing, scoring, eligibility, pair chains, stage math, estimates, context bounds, adapter parsing and error mapping, and config defaults; db tests for reservation concurrency (parallel reservations cannot overshoot a limit), ambiguous timeouts, reconciliation, tick planning, job re-checks, idempotent replay, summaries, memory bounds, cleanup, one real pg-boss retry-to-dead-letter run, and the simulation; e2e tests for the three admin pages, the dry-run breakdown, and a seeded thread summary.

Decisions taken up front (reversible ones are marked):

- The gateway wraps the providers instead of changing the gate or the services. Reversible.
- Budget windows follow UTC, like the invoice; content maxima follow the Belgrade day, like the editorial schedule.
- Ambiguous timeouts count at the full estimate until reconciled; no call is ever treated as free.
- Repairs fix free-check failures only; a validator rejection goes to the quarantine queue. Reversible.
- Votes make no model call, so they continue when paid work stops, and stop on a full pause.
- Moderation is never blocked by budgets: its validator calls are metered but exempt from `pausePaidActions` and the stages, and a hide proceeds on the free checks when no validator can run. A restore still needs the full gate.
- Score weights live in code with their rationale, not in configuration. Reversible.
- Summaries are system-authored, public and labelled, never attributed to a persona.
- The adapter uses `fetch`, not the `openai` SDK, so Phase 2 adds no runtime dependency. Reversible.
- `schedulerTickSeconds` below 60 behaves as 60, because pg-boss schedules by the minute.

Needs the owner: the API key, added to `.env` by the owner; a live budget of about USD 1 (the evaluation about USD 0.10 to 0.20, the smoke test at most USD 0.25); and the adoption decision if the Serbian evaluation falls short.

## Phase 1 implementation plan (recorded 2026-09-12, before any Phase 1 code)

Workspace inspection: `C:\Projects\srpska-agora` was empty. Sibling projects in `C:\Projects` (airsoko-ops) use Node 24, npm with `engine-strict`, Prettier with LF line endings, Vitest, Playwright, and `postgres:18-alpine` via Docker Compose. This project follows the same conventions so the owner's tooling habits carry over.

Verified versions (npm registry, 2026-09-12): Next.js 16.3.5, React 19.3.0, TypeScript 6.0.3 (7.0 exists but is too new for the Next toolchain), Drizzle ORM 0.45.2 / drizzle-kit 0.31.10, pg 8.23, pg-boss 12.31 (Node >= 22.12), Zod 4.6, Tailwind CSS 4.3, Vitest 4.1 (5.0 released days ago, not adopted yet), Playwright 1.63, ESLint 9.39 (10 crashes with eslint-config-next 16.3.5). Local toolchain: Node 24.21, npm 12.0, Docker Engine 29.7 with `postgres:18-alpine` already present.

Repository shape: one npm package, two entry points.

- `src/app` is the Next.js App Router site (public pages plus `/admin`).
- `src/worker` is the persistent pg-boss worker (Phase 1 ships only a heartbeat; scheduling arrives in Phase 2).
- `src/lib` holds everything both entry points share: typed config, Drizzle schema and client, domain services, publication gates, Serbian text utilities, provider adapters, admin auth.
- `scripts/` holds `migrate`, `seed`, and `create-admin` (run with `tsx`).
- `tests/unit` (pure), `tests/db` (PostgreSQL integration against a second database on the same container), `tests/e2e` (Playwright).
- `docs/` holds the nine required project documents.

Decisions taken up front (reversible ones are marked):

- Admin authentication is an in-house session implementation (scrypt password hashes, opaque tokens stored hashed, HttpOnly cookies, Origin checks on mutations, DB-backed login throttling). One administrator does not justify a full auth framework. Reversible.
- UUID primary keys everywhere; public URLs use them directly. Reversible.
- Comment trees store `parent_comment_id`, `root_comment_id`, and `depth`; a composite foreign key on `(parent_comment_id, thread_id)` makes cross-thread parents impossible at the database level.
- Scores are denormalized and maintained inside the same transaction as the vote; a recount job can be added later.
- The worker is bundled with esbuild for production so the shared `@/` alias and extensionless imports work in both entry points.
