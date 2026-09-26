#!/usr/bin/env bash
# Cluster bootstrap: roles, the bantoozi database and its extensions (spec 02 §1.1).
#
# The official postgres:16 image runs *.sh files from /docker-entrypoint-initdb.d/ as the postgres
# superuser, once, when it initializes an empty data directory. The compose files mount this script
# there (compose.dev.yml, compose.test.yml; later the production compose.yml). It must stay
# executable, so the entrypoint runs it in its own shell instead of sourcing it.
#
# Role passwords come from BANTOOZI_OWNER_PASSWORD, BANTOOZI_APP_PASSWORD and
# BANTOOZI_WORKER_PASSWORD. They reach psql as variables and are quoted by psql (:'name'); the shell
# never interpolates them into SQL, because the heredoc delimiter is quoted.
set -euo pipefail

missing=()
for var in BANTOOZI_OWNER_PASSWORD BANTOOZI_APP_PASSWORD BANTOOZI_WORKER_PASSWORD; do
  if [[ -z "${!var:-}" ]]; then
    missing+=("$var")
  fi
done
if ((${#missing[@]} > 0)); then
  {
    echo "init.sh: role password(s) not set or empty: ${missing[*]}. Nothing was created."
    echo "init.sh: set them for the postgres container (spec 02 §1.1), then remove its data"
    echo "init.sh: directory (volume): init scripts run only when the data directory is empty."
  } >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" \
     -v owner_pw="$BANTOOZI_OWNER_PASSWORD" -v app_pw="$BANTOOZI_APP_PASSWORD" -v worker_pw="$BANTOOZI_WORKER_PASSWORD" <<'SQL'
CREATE ROLE bantoozi_owner  LOGIN PASSWORD :'owner_pw'  BYPASSRLS;  -- runs migrations; owns every object and the SECURITY DEFINER functions (§6)
CREATE ROLE bantoozi_app    LOGIN PASSWORD :'app_pw';               -- API; RLS enforced
CREATE ROLE bantoozi_worker LOGIN PASSWORD :'worker_pw' BYPASSRLS;  -- worker, eval CLI, housekeeping
CREATE DATABASE bantoozi OWNER bantoozi_owner;
\connect bantoozi
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO bantoozi_owner;
REVOKE ALL ON DATABASE bantoozi FROM PUBLIC;
GRANT CONNECT ON DATABASE bantoozi TO bantoozi_app, bantoozi_worker;
SQL
