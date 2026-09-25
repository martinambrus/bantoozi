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
