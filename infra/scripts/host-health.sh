#!/usr/bin/env bash
# Host disk report (spec 11 §6.1 "Disk" row): posts one `host_health` ops-event through the API
# container with the capacity of the filesystem holding the PostgreSQL volume and of the filesystem
# holding the backup staging directory: percent used, free bytes and inode use. `house.alerts`
# raises "Disk capacity" above 80 % used or below 10 GB free, and "No host health report" when the
# newest event is older than one hour, so this runs every 15 minutes from the deploy user's crontab:
#
#   */15 * * * * /opt/bantoozi/infra/scripts/host-health.sh --env-file /opt/bantoozi/infra/env/prod.env >>/var/log/bantoozi-host-health.log 2>&1
#
#   infra/scripts/host-health.sh --env-file <file>
#
# The Postgres volume is measured inside the postgres container (`df` of the data directory, which
# reports the host filesystem behind the volume); the backup staging directory is $TMPDIR (default
# /tmp) of the host, where backup.sh and restore-test.sh create their work directories. The two
# are reported as /var/lib/postgresql/data and /backup-staging. The METRICS_TOKEN is read inside
# the API container from its own environment and never appears in an argument or in the output.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT/infra/compose.yml"
ENV_FILE="${BANTOOZI_ENV_FILE:-}"

usage() { echo "usage: host-health.sh --env-file <file>" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) [ $# -ge 2 ] || usage; ENV_FILE="$2"; shift 2 ;;
    --env-file=*) ENV_FILE="${1#--env-file=}"; shift ;;
    -h | --help) usage ;;
    *) echo "host-health: unknown argument $1" >&2; usage ;;
  esac
done
[ -n "$ENV_FILE" ] || { echo "host-health: --env-file is required (or BANTOOZI_ENV_FILE)" >&2; exit 2; }
[ -f "$ENV_FILE" ] || { echo "host-health: env file not found: $ENV_FILE" >&2; exit 2; }
ENV_FILE="$(cd "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")"
if [ -z "${COMPOSE_PROJECT_NAME:-}" ]; then
  line="$(grep -E '^[[:space:]]*COMPOSE_PROJECT_NAME=' "$ENV_FILE" | tail -n 1 || true)"
  line="${line#*=}"; line="${line%\"}"; line="${line#\"}"; line="${line%\'}"; line="${line#\'}"
  export COMPOSE_PROJECT_NAME="${line:-bantoozi-prod}"
fi
dc() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

# fs_entry <mount label> <df -Pk output> <df -Pi output> : one JSON object, or nothing when df gave no data.
fs_entry() {
  local label="$1" kb="$2" inodes="$3"
  awk -v mount="$label" -v inodes="$inodes" '
    NR == 2 {
      used = $3; avail = $4
      total = used + avail
      if (total <= 0) exit 1
      n = split(inodes, lines, "\n")
      split(lines[2], f, " ")
      iused = f[3] + 0; ifree = f[4] + 0
      itotal = iused + ifree
      ipct = (itotal > 0) ? iused * 100 / itotal : 0
      printf "{\"mount\":\"%s\",\"usedPct\":%.1f,\"freeBytes\":%.0f,\"inodesUsedPct\":%.1f}", mount, used * 100 / total, avail * 1024, ipct
    }' <<<"$kb"
}

entries=()
# PostgreSQL volume, measured where the data directory is mounted.
if pg_kb="$(dc exec -T postgres df -Pk /var/lib/postgresql/data 2>/dev/null)" &&
  pg_in="$(dc exec -T postgres df -Pi /var/lib/postgresql/data 2>/dev/null)"; then
  if e="$(fs_entry /var/lib/postgresql/data "$pg_kb" "$pg_in")" && [ -n "$e" ]; then entries+=("$e"); fi
fi
# Backup staging on the host.
STAGING="${TMPDIR:-/tmp}"
if st_kb="$(df -Pk "$STAGING" 2>/dev/null)" && st_in="$(df -Pi "$STAGING" 2>/dev/null)"; then
  if e="$(fs_entry /backup-staging "$st_kb" "$st_in")" && [ -n "$e" ]; then entries+=("$e"); fi
fi
if [ "${#entries[@]}" -eq 0 ]; then
  echo "host-health: no filesystem could be measured (is the postgres container running?)" >&2
  exit 1
fi

# Restart count and OOM state of every compose container (spec 11 §6.1 "repeated OOM/restarts"). The
# disks are the report's purpose: a failing inspect only leaves the "containers" field out.
containers_json() {
  local ids rows
  ids="$(dc ps -a -q 2>/dev/null)" || return 1
  [ -n "$ids" ] || return 1
  # shellcheck disable=SC2086 -- container ids never contain whitespace
  rows="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}} {{.RestartCount}} {{.State.OOMKilled}}' $ids 2>/dev/null)" || return 1
  awk '
    $1 ~ /^[a-z][a-z0-9_.-]{0,40}$/ && $2 ~ /^[0-9]+$/ && ($3 == "true" || $3 == "false") && !($1 in seen) && n < 16 {
      seen[$1] = 1; n++
      out = out (out == "" ? "" : ",") sprintf("\"%s\":{\"restarts\":%d,\"oomKilled\":%s}", $1, $2, $3)
    }
    END { if (n > 0) printf "{%s}", out }' <<<"$rows"
}
CONTAINERS="$(containers_json || true)"
CONTAINERS_FIELD=""
[ -z "$CONTAINERS" ] || CONTAINERS_FIELD=",\"containers\":$CONTAINERS"

HOST="$(hostname 2>/dev/null | tr -c 'A-Za-z0-9._-' '-' | cut -c1-64)"
DETAIL="{\"host\":\"${HOST:-host}\",\"checkedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"filesystems\":[$(IFS=,; echo "${entries[*]}")]${CONTAINERS_FIELD}}"

# The event body goes in on stdin; the bearer token is read inside the container.
printf '%s' "$DETAIL" | dc exec -T api node -e '
let detail = "";
process.stdin.on("data", (c) => { detail += c; }).on("end", async () => {
  try {
    const r = await fetch("http://127.0.0.1:" + (process.env.API_PORT || "3000") + "/api/v1/admin/ops-event", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + process.env.METRICS_TOKEN },
      body: JSON.stringify({ kind: "host_health", detail: JSON.parse(detail) }),
      signal: AbortSignal.timeout(10000),
    });
    if (r.status !== 201) { console.error("ops-event answered " + r.status); process.exit(1); }
  } catch { console.error("ops-event could not be sent"); process.exit(1); }
});' || { echo "host-health: the host_health event could not be recorded" >&2; exit 1; }

echo "host-health: posted $DETAIL"
