# bantoozi

Feed Reader with a taste

## Local development

Prerequisites: Node.js 22.22.2 (`.nvmrc`), pnpm 9 (pinned in `packageManager`; run
`corepack enable`) and Docker with the Compose plugin.

```sh
pnpm i
pnpm db:dev:up                   # Postgres on localhost:5432 (PG_DEV_PORT)
pnpm db:migrate && pnpm db:seed  # schema, settings defaults, taxonomy, question sets, card library
pnpm dev                         # api (:3000), worker and web on http://localhost:5173
```

`pnpm db:dev:up` runs `docker compose -f infra/compose.dev.yml up -d --no-recreate --wait postgres`.
To also start LibreTranslate on localhost:5000 (`LT_DEV_PORT`), run
`docker compose -f infra/compose.dev.yml --profile translate up -d --no-recreate --wait` and set
`LIBRETRANSLATE_URL=http://localhost:5000` for the apps. The first admin signs in with an address
listed in `ADMIN_EMAILS`; in development, login codes are printed to the api console.

### Tests

```sh
pnpm db:test:up   # Postgres for integration tests on localhost:5433 (PG_TEST_PORT)
pnpm test         # unit tests
pnpm test:int     # integration tests against that Postgres
```

**Always use `--no-recreate`** for these containers (the scripts above do): every worktree shares
the `bantoozi-dev` and `bantoozi-test` Compose projects, and a plain `up -d` from another worktree
would recreate them under running sessions. Compose reads overrides (ports, passwords) from the
environment or `infra/.env`, not from a `.env` in the repository root. Production deploys follow
[spec 11](docs/specs/11-operations.md) instead.
