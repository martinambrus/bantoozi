# Resolved dependency versions

Spec 01 §1 locks the stack's major versions; this file records the exact, mutually compatible
versions resolved in M0-T1 (the lockfile `pnpm-lock.yaml` is authoritative). Workspace manifests
pin exact versions (`save-exact`). Update this file in the same commit as any version change.

## Toolchain

| Item | Version | Pinned in | Notes |
|---|---|---|---|
| Node.js | 22.22.2 | `.nvmrc`, root `engines` (`>=22.22.2 <23`, `engine-strict`) | Node 22 LTS (spec 01 §1) |
| pnpm | 9.15.9 | root `packageManager` | newest pnpm 9; newer global pnpm switches to it automatically |
| TypeScript | 5.9.3 | root devDependency | newest 5.x (7.x exists; spec 01 locks 5.x) |
| Turborepo | 2.11.4 | root devDependency | `test:int`, `e2e`, `dev` and the root lint task are never cached |
| Vitest / @vitest/coverage-v8 | 5.0.2 | root devDependency | requires Node ≥ 22.12 and Vite 6–8 |
| Vite | 8.3.1 | root + `apps/web` | |
| ESLint / @eslint/js | 10.11.0 / 10.0.1 | root devDependency | flat config (`eslint.config.js`) |
| typescript-eslint | 8.70.1 | root devDependency | supports ESLint 10 and TypeScript < 6.1 |
| eslint-plugin-boundaries | 7.2.0 | root devDependency | dependency rules of spec 01 §2 (`boundaries/dependencies`, `checkAllOrigins`) |
| eslint-import-resolver-typescript | 4.4.5 | root devDependency | resolves workspace packages to sources for boundary checks |
| @eslint-community/eslint-plugin-eslint-comments | 4.8.1 | root devDependency | disable comments need a reason |
| Prettier | 3.9.9 | root devDependency | |
| tsx | 4.23.15 | root + app devDependencies | dev runner (`--conditions=bantoozi-source`) |
| @types/node | 22.20.4 | root devDependency | matches the Node 22 runtime |
| globals | 17.12.0 | root devDependency | |

## Runtime stack (spec 01 §1)

| Concern | Package | Version | Used by |
|---|---|---|---|
| Validation / DTOs | zod | 4.6.5 | shared, api |
| IDs | uuidv7 | 1.2.1 | shared |
| Logging | pino / pino-pretty (dev) | 10.3.1 / 13.1.3 | shared, api, worker |
| Email | nodemailer | 10.0.10 (+ @types/nodemailer 8.0.2) | shared |
| Language detection | franc-all | 7.2.0 | shared (the "full build" of franc; `francAll` with a whitelist) |
| DB access | drizzle-orm / drizzle-kit | 0.45.3 / 0.31.11 | db |
| Postgres driver | pg | 8.23.0 (+ @types/pg 8.23.1) | db, testing, worker, eval |
| Job queue | pg-boss | 10.4.2 | db (migrate job only), worker — newest 10.x (12.x exists; spec 01 locks 10) |
| HTTP API | fastify | 5.12.5 | api, eval |
| Fastify zod adapter | fastify-type-provider-zod | 7.0.0 (peer: zod ≥ 4.1.5, @fastify/swagger ≥ 9.5.1, openapi-types 12.1.3) | api |
| OpenAPI | @fastify/swagger | 9.9.0 | api |
| Rate limiting | @fastify/rate-limit | 11.2.0 | api |
| Metrics | prom-client | 15.1.3 | api, worker |
| Outbound HTTP | undici | 8.11.2 (requires Node ≥ 22.19) | feeds, engine, translate |
| Feed parsing | rss-parser | 3.13.0 | feeds |
| Extraction | @mozilla/readability / linkedom | 0.6.0 / 0.18.13 | feeds |
| Sanitizing | sanitize-html | 2.17.7 (+ @types/sanitize-html 2.16.1) | feeds |
| CLI | commander | 15.0.0 | worker, eval |

## Web client (spec 01 §1, spec 09)

| Package | Version |
|---|---|
| react / react-dom (+ @types) | 19.3.0 |
| @tanstack/react-router / @tanstack/router-plugin | 1.170.39 / 1.168.40 |
| @tanstack/react-query | 5.103.2 |
| tailwindcss / @tailwindcss/vite | 4.3.3 |
| vite-plugin-pwa | 1.3.0 |
| i18next / react-i18next | 26.4.2 / 17.0.15 |
| @use-gesture/react | 10.3.1 |
| @vitejs/plugin-react | 6.1.1 |
| @playwright/test | 1.56.1 — matches the Chromium build 1194 preinstalled in the development container (M6) |

## Workspace resolution

Library packages publish `dist/` (built by `tsc -b`) and also expose a `bantoozi-source` export
condition pointing at their TypeScript sources. Vitest, Vite and `tsx` resolve with that
condition, so tests and dev servers never depend on stale builds; `tsc -b` uses the declarations
of referenced projects, built in dependency order (spec 01 §6, build and cache contract).
