# Bantoozi — working agreement

- Source of truth: docs/PLAN.md (goals, tasks, order) and docs/specs/*.md (behaviour). Read the spec
  sections a task references before writing code.
- Work in the order and parallel lanes given in PLAN.md. A task is done only when its "Done when" list
  is fully satisfied and `pnpm typecheck && pnpm lint && pnpm test` pass (plus `pnpm test:int` if the
  task touches db, handlers or routes).
- Parallel work (PLAN.md §0.3):
  - The lead session adds all new dependencies and shared registration points (handler maps, route
    registration, i18n namespaces, package exports) **before** starting subagents.
  - Subagents never run `pnpm add`, never edit the lockfile, and never commit.
  - The lead commits each task by path.
  - Only one active branch at a time may add database migrations.
- Start shared containers only with `docker compose … up -d --no-recreate`. Other worktrees use them.
- This shared-container rule applies to dev/test only; production deployment follows spec 11.
- Persist async intents with state in the transactional outbox; consumers must tolerate duplicates.
- Treat unresolved owner decisions in PLAN.md as explicit gates for the affected work only.
- Commit per task: `<task-id>: <summary>` (e.g. `M1-T1: SSRF-safe fetch dispatcher`).
- Never call live third-party APIs in tests; use packages/testing fixtures.
- Deviations from a spec: follow docs/specs/01-architecture.md §9 and log them in docs/DECISIONS.md.
- Locked decisions in PLAN.md §2 are not changed without asking the owner.

## Current state
(append one line per completed milestone: date, milestone, notes)
- 2026-09-25 — M0 Foundations done on branch `claude/exciting-cray-rlrjzj` (`40a6700`…`84f6b02`, PR #2 review fixes `1e36c27`, `87d8e0e`, `82c51a4`, `551acf5`, `2bd9093`; see PLAN.md §5): monorepo and CI, shared config/jobs/crypto/text utils, per-worktree test databases, the full spec 02 schema with RLS, functions, triggers and the pg-boss migrate job, seed, and api/worker/web/eval skeletons in which every queue is a `stage_unavailable` stub. Deviations D-1…D-10; decisions I1–I3 in PLAN.md §17.3. Merge to `main` before starting M1/M2.
- 2026-09-26 — M1 Ingestion core done on branch `claude/confident-ritchie-4h136b` (from `50373a3` on, PR #5; see PLAN.md §6): SSRF-safe fetch client with charset decoding, canonical URL identity, feed parsing/sanitizing with fixtures, R2 media signals (video evidence, in-body image counts, media revision re-ranks), adaptive scheduling, extraction with robots and the shared origin limiter, discovery and OPML, the feed.schedule/feed.fetch/article.extract/article.capture-bookmark handlers with article and feed merges and queue retries for transient page failures, the ingestion E2E test and `pnpm worker-cli`. Deviations D-11…D-20; migrations 0009 (D-13…D-16), 0010 (R2 media columns) and 0011 (D-19). Merge to `main` before M3a/M4/M5.
