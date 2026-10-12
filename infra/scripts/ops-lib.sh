# Shared helpers of backup.sh and restore-test.sh (spec 11 §4). Sourced, not executed.
#
# Secrets never appear in process arguments: they are read from the env file into shell variables
# and handed to containers by NAME (`docker run -e NAME`), which makes the docker client copy the
# value from its own environment. Stage errors are collected in $ERRLOG and only a redacted,
# bounded tail is ever printed or posted.

# The images are pinned by digest; the tools image is built from this checkout (Dockerfile target
# `backup-tools`, no network download at run time).
TOOLS_IMAGE="bantoozi-backup-tools:local"
# Must equal the postgres image of infra/compose.yml (apps/ops/test/ops-scripts.test.ts checks it).
POSTGRES_IMAGE="postgres:16@sha256:1a6ab3f5345eb6dbe04a1349529caabdb0ab09293a09590fad07b2246bfa4b54"

OPS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$OPS_ROOT/infra/compose.yml"
TOOLS_EXTRA=()
REDACT_VALUES=()
ERRLOG=""
WORK=""

ops_die() { echo "$(basename "$0"): $*" >&2; exit 2; }

# Value of NAME in the env file (last assignment wins; surrounding quotes removed). Never printed.
envfile_get() {
  local line
  line="$(grep -E "^[[:space:]]*$1=" "$ENV_FILE" | tail -n 1 || true)"
  line="${line#*=}"
  line="${line%\"}"; line="${line#\"}"; line="${line%\'}"; line="${line#\'}"
  printf '%s' "$line"
}

dc() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

# Reads the env file once: project, bucket settings and the credentials, which stay in shell
# variables (not exported) until a call hands one pair to one container.
ops_load_env() {
  [ -n "$ENV_FILE" ] || ops_die "--env-file is required (or BANTOOZI_ENV_FILE)"
  [ -f "$ENV_FILE" ] || ops_die "env file not found: $ENV_FILE"
  ENV_FILE="$(cd "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")"
  PROJECT="${COMPOSE_PROJECT_NAME:-$(envfile_get COMPOSE_PROJECT_NAME)}"
  PROJECT="${PROJECT:-bantoozi-prod}"
  export COMPOSE_PROJECT_NAME="$PROJECT"
  BACKUP_S3_ENDPOINT="$(envfile_get BACKUP_S3_ENDPOINT)"
  BACKUP_S3_BUCKET="$(envfile_get BACKUP_S3_BUCKET)"
  BACKUP_S3_PREFIX="$(envfile_get BACKUP_S3_PREFIX)"; BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-backups/}"
  BACKUP_S3_REGION="$(envfile_get BACKUP_S3_REGION)"
  BACKUP_S3_LEDGER_PREFIX="$(envfile_get BACKUP_S3_LEDGER_PREFIX)"; BACKUP_S3_LEDGER_PREFIX="${BACKUP_S3_LEDGER_PREFIX:-ledger/}"
  BACKUP_AGE_RECIPIENT="$(envfile_get BACKUP_AGE_RECIPIENT)"
  WRITER_AK="$(envfile_get BACKUP_S3_ACCESS_KEY)"; WRITER_SK="$(envfile_get BACKUP_S3_SECRET_KEY)"
  PRUNE_AK="$(envfile_get BACKUP_S3_PRUNE_ACCESS_KEY)"; PRUNE_SK="$(envfile_get BACKUP_S3_PRUNE_SECRET_KEY)"
  LEDGER_PATH="$(envfile_get DELETION_LEDGER_PATH)"
  [ -n "$BACKUP_S3_ENDPOINT" ] && [ -n "$BACKUP_S3_BUCKET" ] || ops_die "BACKUP_S3_ENDPOINT and BACKUP_S3_BUCKET must be set in the env file"
  case "$BACKUP_S3_PREFIX" in */) ;; *) BACKUP_S3_PREFIX="$BACKUP_S3_PREFIX/" ;; esac
  case "$BACKUP_S3_LEDGER_PREFIX" in */) ;; *) BACKUP_S3_LEDGER_PREFIX="$BACKUP_S3_LEDGER_PREFIX/" ;; esac
  export BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_PREFIX BACKUP_S3_LEDGER_PREFIX BACKUP_AGE_RECIPIENT
  if [ -n "$BACKUP_S3_REGION" ]; then export BACKUP_S3_REGION; fi
  # Values to scrub from anything printed or posted.
  local name value
  while IFS= read -r name; do
    value="$(envfile_get "$name")"
    if [ "${#value}" -ge 6 ]; then REDACT_VALUES+=("$value"); fi
  done < <(grep -oE '^[[:space:]]*[A-Z0-9_]*(PASSWORD|SECRET|TOKEN|PEPPER|KEYS|_KEY|HMAC|SMTP_URL)[A-Z0-9_]*=' "$ENV_FILE" | tr -d ' \t=' | sort -u)
}

ops_workdir() {
  WORK="$(mktemp -d)"; chmod 700 "$WORK"
  ERRLOG="$WORK/errors.log"; : > "$ERRLOG"
}

# redact <text> : the text without secret values, e-mail addresses or long key-like tokens, one line.
redact() {
  local text="$1" v
  for v in "${REDACT_VALUES[@]}"; do text="${text//"$v"/[redacted]}"; done
  printf '%s' "$text" | tr '\n\r\t' '   ' | tr -d '\000-\010\013\014\016-\037' |
    sed -E 's/[[:alnum:]._%+-]+@[[:alnum:].-]+/[email]/g; s/[A-Za-z0-9+\/=_-]{32,}/[redacted]/g'
}

# err_tail : the last lines of the collected stage errors, redacted.
err_tail() { redact "$(tail -n 4 "$ERRLOG" 2>/dev/null || true)"; }

# Throwaway-safe name suffix.
uniq_name() { printf '%s-%s-%s' "$PROJECT" "$1" "$$-$RANDOM"; }

# Builds the tools image from this checkout (cached when nothing changed).
ensure_tools_image() {
  dc --profile tools build backup-tools >>"$ERRLOG" 2>&1 || return 1
}

# tools_run <tool args…> : the backup tools on the compose network (reaches the bucket). Credentials
# are handed over by the caller's `S3_ACCESS_KEY=… S3_SECRET_KEY=… tools_run …` prefix.
tools_run() {
  docker run --rm -i --name "$(uniq_name tools)" --network "${PROJECT}_default" \
    --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
    -e BACKUP_S3_ENDPOINT -e BACKUP_S3_BUCKET -e BACKUP_S3_PREFIX -e BACKUP_S3_REGION \
    -e BACKUP_S3_LEDGER_PREFIX -e S3_ACCESS_KEY -e S3_SECRET_KEY -e BACKUP_AGE_RECIPIENT \
    "${TOOLS_EXTRA[@]}" "$TOOLS_IMAGE" "$@" 2>>"$ERRLOG"
}

# post_event <kind> <detail> : a bounded, redacted ops-event through the API container; the
# METRICS_TOKEN is read there from the container environment, never from an argument.
post_event() {
  local kind="$1" detail
  detail="$(redact "$2")"; detail="${detail:0:1500}"; [ -n "$detail" ] || detail="no detail"
  printf '%s' "$detail" | dc exec -T api node -e '
const kind = process.argv[1];
let detail = "";
process.stdin.on("data", (c) => { detail += c; }).on("end", async () => {
  try {
    const r = await fetch("http://127.0.0.1:" + (process.env.API_PORT || "3000") + "/api/v1/admin/ops-event", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + process.env.METRICS_TOKEN },
      body: JSON.stringify({ kind, detail }),
      signal: AbortSignal.timeout(10000),
    });
    if (r.status !== 201) { console.error("ops-event answered " + r.status); process.exit(1); }
  } catch { console.error("ops-event could not be sent"); process.exit(1); }
});' "$kind" >>"$ERRLOG" 2>&1
}

# json_field <json-line> <name> : a number or plain string field of the one-line JSON the tools print.
json_field() { printf '%s' "$1" | sed -nE "s/.*\"$2\":(\"([^\"]*)\"|([0-9]+)).*/\\2\\3/p"; }

# Static connection budget (spec 11 §2), for deploy.sh and its test. Needs has_profile. API pool 10 +
# worker pool 24 + 20 reserved for pg-boss, migration and backup connections = 54; the laya profile
# adds the worker-laya pool (max 6) and its own pg-boss pool (4), counted separately = 64. The
# combined maximum must stay below 80.
connection_budget() {
  local budget=$((10 + 24 + 20))
  if has_profile laya; then budget=$((budget + 6 + 4)); fi
  echo "$budget"
}
