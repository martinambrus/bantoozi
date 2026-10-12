# syntax=docker/dockerfile:1
# Production images of infra/compose.yml (spec 11 §2, §3). Build context: the repository root.
#   migrate  full built workspace with dev dependencies: `pnpm db:migrate` / `pnpm db:seed` run through tsx
#   api      production dependencies + built apps/api (no source, no dev dependencies)
#   worker   production dependencies + built apps/worker + packages/questions/library/*.json
#   caddy    pinned Caddy + the built web app at /srv/web + the Caddyfile
#   backup-tools  the apps/ops commands behind infra/scripts/backup.sh and restore-test.sh
# Every dependency install uses the frozen lockfile. `pnpm deploy` is not used: it packs files by the
# publish rules and drops the gitignored dist/ folders, so the built output is copied explicitly.

# node:22.22-slim (Node 22.22.3, multi-arch index digest).
ARG NODE_IMAGE=node:22.22-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752
ARG CADDY_IMAGE=caddy:2@sha256:0c994536bddb66445885237f1a5dcc1916bccea922661c76b4e9fc24061f9b52

FROM ${NODE_IMAGE} AS base
ENV CI=true \
    npm_config_update_notifier=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false
RUN npm install --global pnpm@9.15.9 && npm cache clean --force
WORKDIR /app

# Workspace manifests only: the install layer is reused until a dependency changes.
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/eval/package.json apps/eval/package.json
COPY apps/ops/package.json apps/ops/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/engine/package.json packages/engine/package.json
COPY packages/feeds/package.json packages/feeds/package.json
COPY packages/questions/package.json packages/questions/package.json
COPY packages/ranker/package.json packages/ranker/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/testing/package.json packages/testing/package.json
COPY packages/translate/package.json packages/translate/package.json

FROM manifests AS dev-deps
RUN --mount=type=cache,id=bantoozi-pnpm-store,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store \
    && pnpm install --frozen-lockfile

# Build: the API, the worker (with every package they use) and the web app.
FROM dev-deps AS build
COPY . .
RUN pnpm --filter @bantoozi/api... --filter @bantoozi/worker... build \
    && pnpm --filter @bantoozi/web build

# One-off jobs: migration and seed (the seed runs with the worker's environment).
FROM build AS migrate
ENV NODE_ENV=production \
    HOME=/tmp
USER 1000:1000
CMD ["pnpm", "db:migrate"]

# Production-only dependency trees (workspace links stay relative, so the layout is kept).
FROM manifests AS prod-deps-api
RUN --mount=type=cache,id=bantoozi-pnpm-store,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store \
    && pnpm install --frozen-lockfile --prod --filter "@bantoozi/api..."

FROM manifests AS prod-deps-worker
RUN --mount=type=cache,id=bantoozi-pnpm-store,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store \
    && pnpm install --frozen-lockfile --prod --filter "@bantoozi/worker..."

FROM base AS api
ENV NODE_ENV=production \
    HOME=/tmp
COPY --from=prod-deps-api /app /app
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/packages/db/dist packages/db/dist
COPY --from=build /app/packages/db/drizzle packages/db/drizzle
COPY --from=build /app/packages/feeds/dist packages/feeds/dist
COPY --from=build /app/packages/questions/dist packages/questions/dist
COPY --from=build /app/packages/ranker/dist packages/ranker/dist
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/translate/dist packages/translate/dist
WORKDIR /app/apps/api
USER 1000:1000
CMD ["node", "dist/main.js"]

FROM base AS worker
ENV NODE_ENV=production \
    HOME=/tmp
COPY --from=prod-deps-worker /app /app
COPY --from=build /app/apps/worker/dist apps/worker/dist
COPY --from=build /app/packages/db/dist packages/db/dist
COPY --from=build /app/packages/db/drizzle packages/db/drizzle
COPY --from=build /app/packages/engine/dist packages/engine/dist
COPY --from=build /app/packages/feeds/dist packages/feeds/dist
COPY --from=build /app/packages/questions/dist packages/questions/dist
# The seed loads the card library at runtime, beside the built packages/questions (spec 11 §2, D-50).
COPY --from=build /app/packages/questions/library packages/questions/library
COPY --from=build /app/packages/ranker/dist packages/ranker/dist
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/translate/dist packages/translate/dist
# The deletion ledger volume (spec 11 §5.1): a new named volume takes this directory's owner.
RUN mkdir -p /var/lib/bantoozi/ledger && chown -R 1000:1000 /var/lib/bantoozi
WORKDIR /app/apps/worker
USER 1000:1000
CMD ["node", "dist/main.js"]

# Backup and restore tools (spec 11 §4): the apps/ops commands (age streaming, S3, restore
# verification, ledger replay) run from source through tsx, so nothing here is built. The PostgreSQL
# 16 client tools are not part of this image: pg_dump runs in the live postgres container and
# pg_restore in the throwaway one, both from the postgres image pinned in compose.yml.
FROM dev-deps AS backup-tools
ENV NODE_ENV=production \
    HOME=/tmp
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/ops apps/ops
WORKDIR /app/apps/ops
USER 1000:1000
ENTRYPOINT ["node_modules/.bin/tsx", "--conditions=bantoozi-source", "src/cli.ts"]

FROM ${CADDY_IMAGE} AS caddy
COPY --from=build /app/apps/web/dist /srv/web
COPY infra/caddy/Caddyfile /etc/caddy/Caddyfile
