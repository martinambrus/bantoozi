# Spec deviations

Every deviation from a binding spec is recorded here through the process of
[spec 01 §9](./specs/01-architecture.md): the smallest change that keeps the spec's intent, logged as
`D-<n>: <date> <task id> <what changed> <why>`, with the affected spec text updated in the same
commit. Locked decisions (PLAN.md §2) are never changed here.

- D-1: 2026-09-25 M0-T2 — `packages/shared` has two public entries besides its main `index.ts`:
  `@bantoozi/shared/server` (config, logger, mailer, `sha256Hex`/`cardTextHash`, `detectLanguage`)
  and `@bantoozi/shared/server/credential-crypto`. Spec 01 §5 said "one public `index.ts` per package",
  but the web client imports the shared DTOs, and a main entry that re-exports Node-only modules
  (`node:crypto`, nodemailer, pino, franc) would pull them into the browser bundle. Each entry is a
  curated index; internal files are still never imported from outside. Spec 01 §5 updated.
- D-2: 2026-09-25 M0-T2 — `loadConfig` adds production-only refusals that the spec's intent
  implies but its table did not state: `MAIL_TRANSPORT=log` (would print login codes; spec 01 §5 "never
  log email codes"), non-`https` `PUBLIC_BASE_URL`/`TYPESAFE_BASE_URL`/`OLLAMA_BASE_URL` (spec 04
  §1.2 sends keys only to HTTPS origins), an unpinned `TYPESAFE_MODEL` ("always a pinned version in
  production"), and a `SESSION_PEPPER`/`METRICS_TOKEN` shorter than 32 characters. Spec 01 §3 updated.
- D-3: 2026-09-25 M0-T3 — new compose-only variable `LT_DEV_PORT` (default 5000): the host port of the
  dev LibreTranslate in `infra/compose.dev.yml`. Spec 11 §2 requires Compose host ports to come from
  the environment, but spec 01 §3 listed only `PG_DEV_PORT`/`PG_TEST_PORT`. Dev and test ports are
  published on 127.0.0.1 only. Spec 01 §3 table updated; `.env.example` and the config registry list it.
- D-4: 2026-09-25 M0-T5 — clarification of an unspecified hash: `analysis_requests.input_sha` and
  `card_publication_requests.publication_sha` are the hex SHA-256 of the stored `jsonb` value's
  PostgreSQL text rendering (`encode(sha256(convert_to(x::text, 'UTF8')), 'hex')`), not of
  `canonicalJson`. `jsonb` normalizes key order and number spelling itself, so the database can compute
  and verify the hash exactly (the §5.2 triggers reject a mismatch), which a JavaScript canonical form
  cannot guarantee for every number. Spec 02 §3.4 updated; it also names the §1.2 aggregate
  `queue_state_counts()`.
- D-5: 2026-09-25 M0-T5 — `admin_usage_attribution` ends with `WHERE admin_context_allowed() AND
  p_days BETWEEN 1 AND 366`. The §6 text filtered only the usage window by `p_days`, so an invalid
  value still returned one zero-cost row per current holder through the `shared` CTE, contradicting
  §6 "Callers" ("direct SQL calls return no usage rows"). Found by the M0 function tests; spec 02 §6
  updated.
- D-6: 2026-09-26 M0-T5 (owner-approved) — `articles.cluster_set_id` and
  `card_suggestions.question_set_id` reference `question_sets(id)` with `ON DELETE RESTRICT`. Spec 02
  gave these two foreign keys no `ON DELETE` clause (so PostgreSQL's default `NO ACTION` applied),
  although its introduction requires every foreign key to state one; every other `question_sets`
  reference already uses `RESTRICT`, and question sets are never deleted while referenced. Migration
  0006; spec 02 §3 and §4 updated.
- D-7: 2026-09-26 M0-T5 — clarification of unspecified values: the migrate job opens its connection
  with `lock_timeout` 30 s (pg-boss's own lock bound) and `statement_timeout` 5 min as startup
  parameters, so both also bound the wait for the migrate advisory lock. A held lock or a hung
  statement fails the job with SQLSTATE 55P03 or 57014; the interrupted transaction rolls back (all
  pending Drizzle migrations share one), so deployment stops before application replacement and a
  re-run converges. Spec 11 §3 required bounded timeouts without values, and the first migrate job
  set none (found by the PR #2 review). Spec 11 §3 updated.
- D-8: 2026-09-26 M0-T7 — `pipeline.after('cluster')` records `user.rank {full: true}` (reason
  `cluster`) for every user whose window holds a member of the article's story when the cluster stage
  reports a membership change (`clusterChanged`). Spec 03 §1–2 routed nothing after clustering, but
  cluster and match run in parallel, so match could rank an article before it joined a muted or read
  story, and spec 06 §7 step 2 requires a cluster-membership change to enqueue a full rank (spec 05 §6
  step 5 already did so for merges). Found by the PR #2 review; spec 03 §1 (diagram and text) and the
  §2 `user.rank` producers updated.
- D-9: 2026-09-26 M0-T5 — the topic reference triggers lock the rows they read, as a foreign-key
  check does: `interest_cards_content_check` takes `FOR KEY SHARE` on every referenced topic, and
  `topics_parent_check` takes `FOR SHARE` on a level-2 topic's parent. Without the locks, a card write
  and a concurrent delete or id change of one of its topics (or a new child and a concurrent level
  change of its parent) could both pass their READ COMMITTED checks and commit a dangling reference,
  which no foreign key repairs because `topic_ids` is an array (found by the PR #2 review). Migration
  0007; spec 02 §5.2 updated.
- D-10: 2026-09-26 M0-T5 — both deferred label checks (`user_article_labels_check`,
  `user_labels_removal_check`) first lock the owning `users` row `FOR NO KEY UPDATE`, the row spec 02
  §5.2 already serializes label changes and assignments on. Both run at COMMIT, so without the lock a
  transaction assigning a label and one removing it could each pass against its own snapshot and
  leave `label_ids` or `label_suggestions` naming a label the user no longer holds (found by the PR #2
  review). Migration 0008; spec 02 §5.2 updated.
- D-11: 2026-09-26 M1-T2 — a canonical URL longer than 2,048 UTF-8 bytes is not its own `url_key`:
  its key is `'sha256:' + sha256Hex(canonical_url)`. Spec 03 §5 step 7 made `url_key` the canonical
  URL itself, but `articles.url_key` and `article_aliases.url_key` are unique B-tree keys, and
  PostgreSQL rejects index entries of about 2.7 KB, so one overlong publisher link would fail its
  item on every fetch. The hash keeps the identity global and deterministic (the same overlong URL
  from two feeds is still one article), `canonical_url` keeps the full URL, and `safeFetch` already
  rejects URLs above 8,192 bytes. Spec 03 §5 step 7 updated.
