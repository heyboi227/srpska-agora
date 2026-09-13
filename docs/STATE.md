# Project state

This file tracks what is built, what is next, and what is blocked. It is updated at the end of every phase.

## Phase status

| Phase                   | Status                |
| ----------------------- | --------------------- |
| 1 Foundation            | complete (2026-09-13) |
| 2 Controlled autonomy   | not started           |
| 3 Real news             | not started           |
| 4 Evolving forum        | not started           |
| 5 Operational readiness | not started           |

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
- Owner decision after inspecting the Phase 1 demo: proceed to Phase 2 as outlined, or adjust scope.

## Implementation plan (recorded 2026-09-12, before any Phase 1 code)

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
