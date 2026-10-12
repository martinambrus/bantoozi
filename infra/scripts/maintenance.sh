#!/usr/bin/env bash
# Maintenance mode of the public site (spec 11 §3 step 6, §4.1 step 1).
#
#   infra/scripts/maintenance.sh --env-file <file> on|off|status
#
# `on` creates the flag file /data/maintenance/on in the caddy-data volume; Caddy checks it on every
# request (infra/caddy/Caddyfile) and answers every public route with a static 503 page and a
# Retry-After header, except /api/v1/readyz. The flag lives in the named volume, so it survives a
# restart or recreate of the caddy container. `off` removes it. `status` prints `maintenance: on` or
# `maintenance: off`. All three are idempotent. deploy.sh turns the mode on when a failed smoke
# leaves compatibility undemonstrated; the operator turns it off after checking the site.
#
# The flag is written through the running caddy container; when it is not running, through a
# one-off container of the same image that mounts the same volume (no ports, no dependencies).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT/infra/compose.yml"
ENV_FILE="${BANTOOZI_ENV_FILE:-}"
ACTION=""

usage() { echo "usage: maintenance.sh --env-file <file> on|off|status" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) [ $# -ge 2 ] || usage; ENV_FILE="$2"; shift 2 ;;
    --env-file=*) ENV_FILE="${1#--env-file=}"; shift ;;
    on | off | status) [ -z "$ACTION" ] || usage; ACTION="$1"; shift ;;
    -h | --help) usage ;;
    *) echo "maintenance: unknown argument $1" >&2; usage ;;
  esac
done
[ -n "$ACTION" ] || usage
[ -n "$ENV_FILE" ] || { echo "maintenance: --env-file is required (or BANTOOZI_ENV_FILE)" >&2; exit 2; }
[ -f "$ENV_FILE" ] || { echo "maintenance: env file not found: $ENV_FILE" >&2; exit 2; }
ENV_FILE="$(cd "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")"

# The project name is read like deploy.sh does; the script never passes -p.
if [ -z "${COMPOSE_PROJECT_NAME:-}" ]; then
  line="$(grep -E '^[[:space:]]*COMPOSE_PROJECT_NAME=' "$ENV_FILE" | tail -n 1 || true)"
  line="${line#*=}"; line="${line%\"}"; line="${line#\"}"; line="${line%\'}"; line="${line#\'}"
  export COMPOSE_PROJECT_NAME="${line:-bantoozi-prod}"
fi

dc() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }
FLAG_DIR=/data/maintenance
FLAG="$FLAG_DIR/on"

# in_caddy <sh -c script> : run in the caddy container, or in a one-off one when it is not running.
in_caddy() {
  local running
  running="$(dc ps --status running -q caddy 2>/dev/null | head -n 1 || true)"
  if [ -n "$running" ]; then
    dc exec -T caddy sh -c "$1"
  else
    dc run --rm --no-deps -T --no-build --entrypoint sh caddy -c "$1"
  fi
}

case "$ACTION" in
  on)
    in_caddy "mkdir -p $FLAG_DIR && date -u +%Y-%m-%dT%H:%M:%SZ > $FLAG" >/dev/null
    echo "maintenance: on"
    ;;
  off)
    in_caddy "rm -f $FLAG" >/dev/null
    echo "maintenance: off"
    ;;
  status)
    if in_caddy "test -e $FLAG" >/dev/null 2>&1; then echo "maintenance: on"; else echo "maintenance: off"; fi
    ;;
esac
