#!/usr/bin/env bash
# Deploy a release to the single production host (spec 11 §3).
#
#   infra/scripts/deploy.sh [--env-file <file>] [--local-rehearsal] <git-ref>
#
# Steps: lock and clean checkout -> validate the environment and the stored settings against the
# enabled profiles (language modes, card text mode, engine.laya and Laya work; fails before anything
# is replaced) -> pre-deploy backup -> build immutable images (frozen lockfile) -> Postgres healthy ->
# migration job (exit 0 required) -> seed job (exit 0) -> replace the application containers -> smoke
# (up to 120 s: readyz, login page, static asset, worker heartbeat, outbox dispatch and a queue
# traversal) -> deploy log with the image ids. If the smoke fails, the previous application images are
# restored and the script exits non-zero; when the restored stack is not healthy either (compatibility
# cannot be demonstrated, spec 11 §3 step 6) maintenance mode is switched on (infra/scripts/maintenance.sh)
# and stays on until the operator turns it off.
#
# A fresh instance (no Postgres volume or database yet) skips the pre-deploy backup and says so.
#
# --env-file       host secrets file (mode 600); default infra/env/prod.env is NOT assumed: pass it.
# --local-rehearsal  production-like rehearsal on a developer machine: skips the release-tag and the
#                  pre-deploy backup preconditions (and says so), adds the `rehearsal` compose profile
#                  (mail catcher) and does not need the internet. Use a COMPOSE_PROJECT_NAME of its
#                  own in the env file; the script never passes -p.
#
# Environment: DEPLOY_STATE_DIR (lock and logs; default ~/.local/state/bantoozi/deploy),
# DEPLOY_MIN_FREE_GB (default 10; 5 in a rehearsal), DEPLOY_SMOKE_TIMEOUT (seconds, default 120).
# Secret values are never printed: only variable names appear in messages.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT/infra/compose.yml"
ENV_FILE=""
REHEARSAL=0
REF=""

usage() {
  echo "usage: deploy.sh [--env-file <file>] [--local-rehearsal] <git-ref>" >&2
  exit 2
}
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) [ $# -ge 2 ] || usage; ENV_FILE="$2"; shift 2 ;;
    --env-file=*) ENV_FILE="${1#--env-file=}"; shift ;;
    --local-rehearsal) REHEARSAL=1; shift ;;
    -h | --help) usage ;;
    -*) echo "deploy: unknown option $1" >&2; usage ;;
    *) [ -z "$REF" ] || usage; REF="$1"; shift ;;
  esac
done
[ -n "$REF" ] || usage
[ -n "$ENV_FILE" ] || { echo "deploy: --env-file is required" >&2; exit 2; }
[ -f "$ENV_FILE" ] || { echo "deploy: env file not found: $ENV_FILE" >&2; exit 2; }
ENV_FILE="$(cd "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")"

STATE_DIR="${DEPLOY_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/bantoozi/deploy}"
mkdir -p "$STATE_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG="$STATE_DIR/deploy-$STAMP.log"
SMOKE_TIMEOUT="${DEPLOY_SMOKE_TIMEOUT:-120}"
# Everything printed also goes to the deploy log.
exec > >(tee -a "$LOG") 2>&1

step() { echo "step: $*"; }
die() { echo "deploy: FAILED: $*" >&2; exit 1; }

# Value of NAME in the env file (last assignment wins; surrounding quotes removed). Never printed.
envfile_get() {
  local line
  line="$(grep -E "^[[:space:]]*$1=" "$ENV_FILE" | tail -n 1 || true)"
  line="${line#*=}"
  line="${line%\"}"; line="${line#\"}"; line="${line%\'}"; line="${line#\'}"
  printf '%s' "$line"
}

dc() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "${PROFILE_ARGS[@]}" "$@"; }

echo "deploy: $(date -u +%FT%TZ) ref=$REF env=$(basename "$ENV_FILE")"

# ── Profiles ─────────────────────────────────────────────────────────────────────────────────
PROFILE_ARGS=()
PROFILES=()
IFS=',' read -r -a _requested <<<"$(envfile_get COMPOSE_PROFILES)"
for p in "${_requested[@]:-}"; do
  p="${p// /}"
  [ -n "$p" ] || continue
  case "$p" in translate | laya) PROFILES+=("$p") ;; rehearsal) ;; *) die "unknown compose profile in COMPOSE_PROFILES: $p" ;; esac
done
if [ "$REHEARSAL" = 1 ]; then PROFILES+=(rehearsal); fi
for p in "${PROFILES[@]:-}"; do [ -n "$p" ] && PROFILE_ARGS+=(--profile "$p"); done
has_profile() { local p; for p in "${PROFILES[@]:-}"; do [ "$p" = "$1" ] && return 0; done; return 1; }
# The worker-laya queues (article.enrich.laya, analysis.process.laya) have no handlers before M9, so a
# worker-laya would refuse production startup; keep the profile unavailable until then (D-197).
has_profile laya && die "the laya profile is not available before M9: its worker has no handlers yet; remove laya from COMPOSE_PROFILES"

# ── 1. Lock, release and clean checkout ──────────────────────────────────────────────────────
PROJECT="$(envfile_get COMPOSE_PROJECT_NAME)"
PROJECT="${COMPOSE_PROJECT_NAME:-${PROJECT:-bantoozi-prod}}"
export COMPOSE_PROJECT_NAME="$PROJECT"
exec 9>"$STATE_DIR/$PROJECT.lock"
flock -n 9 || die "another deploy of $PROJECT holds the lock"

cd "$ROOT"
COMMIT="$(git rev-parse --verify "$REF^{commit}" 2>/dev/null)" || die "cannot resolve ref: $REF"
HEAD_COMMIT="$(git rev-parse HEAD)"
[ "$COMMIT" = "$HEAD_COMMIT" ] || die "the checkout is at ${HEAD_COMMIT:0:12}, not at $REF (${COMMIT:0:12}); check the release out first"
DIRTY="$(git status --porcelain --untracked-files=normal | wc -l)"
if [ "$REHEARSAL" = 1 ]; then
  echo "deploy: local rehearsal: skipping the release-tag requirement"
  [ "$DIRTY" -eq 0 ] || echo "deploy: local rehearsal: the working tree has $DIRTY uncommitted path(s); building the working tree as is"
else
  [[ "$REF" =~ ^v[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[0-9]+$ ]] || die "production deploys take a release tag vYYYY.MM.DD-N, got: $REF"
  [ "$DIRTY" -eq 0 ] || die "the checkout is not clean ($DIRTY uncommitted path(s))"
fi
echo "deploy: project=$PROJECT commit=${COMMIT:0:12} mode=$([ "$REHEARSAL" = 1 ] && echo local-rehearsal || echo production)"

# ── 2. Validate the environment, the profiles and the host ───────────────────────────────────
REQUIRED=(PUBLIC_HOST ACME_EMAIL PUBLIC_BASE_URL POSTGRES_PASSWORD BANTOOZI_OWNER_PASSWORD
  BANTOOZI_APP_PASSWORD BANTOOZI_WORKER_PASSWORD SESSION_PEPPER METRICS_TOKEN TYPESAFE_MODEL
  MAIL_TRANSPORT SMTP_URL ADMIN_EMAILS DELETION_LEDGER_PATH DELETION_LEDGER_RECIPIENT DELETION_HMAC_KEY)
missing=()
placeholder=()
for v in "${REQUIRED[@]}"; do
  val="$(envfile_get "$v")"
  if [ -z "$val" ]; then missing+=("$v"); continue; fi
  case "$val" in change-me* | *change-me* | age1changeme* | *example.com*) [ "$REHEARSAL" = 1 ] || placeholder+=("$v") ;; esac
done
if [ "${#missing[@]}" -gt 0 ]; then die "required variables missing or empty in the env file: ${missing[*]}"; fi
if [ "${#placeholder[@]}" -gt 0 ]; then die "variables still hold placeholder values: ${placeholder[*]}"; fi
# The worker refuses a ledger path off the persistent volume (spec 11 §5.1); catch it before any backup.
ledger_norm="$(realpath -m -- "$(envfile_get DELETION_LEDGER_PATH)" 2>/dev/null || true)"
case "$(envfile_get DELETION_LEDGER_PATH)" in
  /var/lib/bantoozi/ledger/*) [[ "$ledger_norm" == /var/lib/bantoozi/ledger/* ]] || die "DELETION_LEDGER_PATH must be inside /var/lib/bantoozi/ledger/ (the persistent ledger volume)" ;;
  *) die "DELETION_LEDGER_PATH must be inside /var/lib/bantoozi/ledger/ (the persistent ledger volume)" ;;
esac
if [ "$(envfile_get MAIL_TRANSPORT)" != smtp ]; then die "MAIL_TRANSPORT must be smtp in production"; fi
pw_dupes="$(for v in POSTGRES_PASSWORD BANTOOZI_OWNER_PASSWORD BANTOOZI_APP_PASSWORD BANTOOZI_WORKER_PASSWORD; do envfile_get "$v"; echo; done | grep -v '^$' | sort | uniq -d | wc -l)"
[ "$pw_dupes" -eq 0 ] || die "the database passwords must be distinct"
modes="$(envfile_get LANGUAGE_MODES)"
if { [[ "$modes" == *translate* ]] || [ "$(envfile_get CARD_TEXT_MODE)" = english ]; } && ! has_profile translate; then
  die "LANGUAGE_MODES asks for translation: enable the translate profile (COMPOSE_PROFILES=translate)"
fi

# Stored state against the enabled profiles (spec 11 §3 step 4). A fresh instance has no database to
# read; otherwise the stored settings and the outstanding queue work are checked before anything is
# replaced.
FRESH=0
FRESH_REASON=""
PG_VOLUME="$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.volume=pgdata" | head -n 1 || true)"
if [ -z "$PG_VOLUME" ]; then
  FRESH=1; FRESH_REASON="no database volume yet"
else
  if [ -z "$(dc ps --status running -q postgres 2>/dev/null | head -n 1)" ]; then
    echo "deploy: starting postgres to read the stored settings"
    dc up -d --no-build --wait --wait-timeout 180 postgres >/dev/null 2>&1 || die "postgres did not become healthy"
  fi
  have_db="$(dc exec -T postgres psql -U postgres -d postgres -X -tAq -c "select count(*) from pg_database where datname = 'bantoozi'" 2>/dev/null | tr -d '[:space:]' || true)"
  if [ "$have_db" != 1 ]; then FRESH=1; FRESH_REASON="no database yet"; fi
fi
dbq() { dc exec -T postgres psql -U postgres -d bantoozi -X -tAq -v ON_ERROR_STOP=1 -c "$1" 2>/dev/null | tr -d '\r' || true; }
if [ "$FRESH" = 0 ] && [ "$(dbq "select to_regclass('public.settings') is not null")" = t ]; then
  if ! has_profile translate; then
    stored_translate="$(dbq "select coalesce(string_agg(e.key, ', ' order by e.key), '') from (select value from settings where key = 'language_modes' and jsonb_typeof(value) = 'object') s, jsonb_each_text(s.value) e where e.value = 'translate'")"
    [ -z "$stored_translate" ] || die "stored language_modes set translate for: $stored_translate; enable the translate profile (COMPOSE_PROFILES=translate) or change the language mode first"
    stored_card_mode="$(dbq "select coalesce(value #>> '{}', '') from settings where key = 'card_text_mode'")"
    [ "$stored_card_mode" != english ] || die "stored card_text_mode is english: enable the translate profile (COMPOSE_PROFILES=translate) or change card_text_mode first"
  fi
  if ! has_profile laya; then
    stored_laya="$(dbq "select coalesce(string_agg(l, ', '), '') from (select jsonb_array_elements_text(value -> 'enrich') l from settings where key = 'engine.laya' and jsonb_typeof(value -> 'enrich') = 'array') x")"
    [ -z "$stored_laya" ] || die "stored engine.laya lists languages ($stored_laya): enable the laya profile (COMPOSE_PROFILES=laya) or empty engine.laya first"
    laya_outbox="$(dbq "select count(*) from job_outbox where delivered_at is null and queue like '%.laya'")"
    laya_queue=0
    if [ "$(dbq "select to_regclass('pgboss.job') is not null")" = t ]; then
      laya_queue="$(dbq "select count(*) from pgboss.job where name like '%.laya' and state in ('created', 'retry', 'active')")"
    fi
    if [ "${laya_outbox:-0}" -gt 0 ] || [ "${laya_queue:-0}" -gt 0 ]; then
      die "Laya work is outstanding (outbox ${laya_outbox:-0}, queue ${laya_queue:-0}): enable the laya profile (COMPOSE_PROFILES=laya) or let it drain first"
    fi
  fi
  echo "deploy: stored settings and queue work agree with the enabled profiles"
fi

# Static connection budget (spec 11 §2; ops-lib.sh connection_budget): 54, or 64 with the laya profile.
# Sourced in a subshell: ops-lib.sh redefines dc() and others that this script needs unchanged.
BUDGET="$(. "$ROOT/infra/scripts/ops-lib.sh"; connection_budget)"
[ "$BUDGET" -lt 80 ] || die "connection budget $BUDGET exceeds the 80 allowed; lower the pools first"
MIN_FREE="${DEPLOY_MIN_FREE_GB:-$([ "$REHEARSAL" = 1 ] && echo 5 || echo 10)}"
DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /)"
FREE_GB="$(df -Pk "$DOCKER_ROOT" 2>/dev/null | awk 'NR==2 {print int($4/1048576)}')"
[ -n "$FREE_GB" ] && [ "$FREE_GB" -ge "$MIN_FREE" ] || die "free disk ${FREE_GB:-?} GB is below the required $MIN_FREE GB"
dc config --quiet >/dev/null 2>&1 || die "docker compose cannot render the stack from the env file (a required variable is probably unset)"
echo "deploy: environment ok (profiles: ${PROFILES[*]:-none}; connection budget $BUDGET/80; free disk ${FREE_GB} GB)"

APP_SERVICES=(api worker)
has_profile laya && APP_SERVICES+=(worker-laya)
APP_SERVICES+=(caddy)

# Previous application images (restored if the smoke fails) and the schema version.
declare -A PREV_ID PREV_NAME PREV_SHA
for svc in "${APP_SERVICES[@]}"; do
  cid="$(dc ps -aq "$svc" 2>/dev/null | head -n 1 || true)"
  if [ -n "$cid" ]; then
    PREV_ID[$svc]="$(docker inspect -f '{{.Image}}' "$cid")"
    PREV_NAME[$svc]="$(docker inspect -f '{{.Config.Image}}' "$cid")"
    docker tag "${PREV_ID[$svc]}" "${PREV_NAME[$svc]%%:*}:previous" >/dev/null
    # The commit the previous image was built from: every deploy tags its images with the 12-character
    # commit (below), so the tag names the release the "previous" images belong to.
    PREV_SHA[$svc]="$(docker image inspect "${PREV_ID[$svc]}" --format '{{range .RepoTags}}{{println .}}{{end}}' 2>/dev/null | sed -nE 's/.*:([0-9a-f]{12})$/\1/p' | head -n 1 || true)"
    echo "deploy: previous $svc image ${PREV_ID[$svc]#sha256:}"
  else
    echo "deploy: previous $svc image none (first deploy)"
  fi
done
SCHEMA_BEFORE="$(dc exec -T postgres psql -U postgres -d bantoozi -tAc 'select count(*) from drizzle.__drizzle_migrations' 2>/dev/null | tr -d '[:space:]' || true)"
echo "deploy: schema version before: ${SCHEMA_BEFORE:-none}"

BACKUP="$ROOT/infra/scripts/backup.sh"
backup_configured() {
  local v
  for v in BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY BACKUP_S3_SECRET_KEY BACKUP_AGE_RECIPIENT; do
    [ -n "$(envfile_get "$v")" ] || return 1
  done
}
if [ "$FRESH" = 1 ]; then
  echo "deploy: pre-deploy backup skipped: fresh instance ($FRESH_REASON), nothing to back up"
elif [ "$REHEARSAL" = 1 ] && ! backup_configured; then
  echo "deploy: local rehearsal: pre-deploy backup skipped: rehearsal without BACKUP_S3_* and BACKUP_AGE_RECIPIENT in the env file"
else
  [ -x "$BACKUP" ] || die "the pre-deploy backup is required (spec 11 §3 step 2) but $BACKUP does not exist yet"
  if [ "$REHEARSAL" = 1 ] && [ "$(envfile_get BACKUP_S3_ENDPOINT)" = "http://minio:9000" ]; then
    # The S3 stand-in of the rehearsal profile: running, with the bucket present (a directory of the data root).
    dc up -d --no-deps --no-build --wait --wait-timeout 120 minio >/dev/null || die "the S3 stand-in (minio) did not become healthy"
    dc exec -T minio mkdir -p "/data/$(envfile_get BACKUP_S3_BUCKET)" || die "could not create the bucket on the S3 stand-in"
  fi
  # Built here, ahead of the backup, so a first image build cannot time out inside backup.sh.
  step "build the backup tools image"
  dc --profile tools build backup-tools >/dev/null 2>&1 || die "the backup tools image build failed"
  step "pre-deploy backup"
  "$BACKUP" --pre-deploy --env-file "$ENV_FILE" || die "the pre-deploy backup failed"
fi

# ── 1 (cont.). Build immutable images ────────────────────────────────────────────────────────
BUILD_LOG="$STATE_DIR/build-$STAMP.log"
step "build (frozen lockfile; log $BUILD_LOG)"
if ! dc build --progress=plain >"$BUILD_LOG" 2>&1; then
  tail -n 25 "$BUILD_LOG" >&2
  die "image build failed"
fi
declare -A NEW_ID
for svc in "${APP_SERVICES[@]}"; do
  img="$(dc config --images 2>/dev/null | grep -E -- "-$svc(:|$)" | head -n 1)"
  NEW_ID[$svc]="$(docker image inspect "$img" --format '{{.Id}}')"
  docker tag "$img" "${img%%:*}:${COMMIT:0:12}" >/dev/null
done

# ── 3. Postgres, then the migration and seed jobs ────────────────────────────────────────────
step "postgres"
dc up -d --no-build --wait --wait-timeout 180 postgres >/dev/null || die "postgres did not become healthy"

JOB_LOG="$STATE_DIR/jobs-$STAMP.log"
run_job() { # service
  local svc="$1" rc
  dc up --no-build --no-deps --exit-code-from "$svc" "$svc" >>"$JOB_LOG" 2>&1 && rc=0 || rc=$?
  if [ "$rc" -ne 0 ]; then
    dc logs --no-color --tail 25 "$svc" >&2 || true
    die "the $svc job exited with $rc; application containers were not replaced"
  fi
  local code
  code="$(docker inspect -f '{{.State.ExitCode}}' "$(dc ps -aq "$svc" | head -n 1)")"
  [ "$code" = 0 ] || die "the $svc job exited with $code; application containers were not replaced"
}
step "migrate (exit 0 required)"
run_job migrate
echo "deploy: migration job finished with exit 0"
step "seed (exit 0 required)"
run_job seed
echo "deploy: seed job finished with exit 0"

# ── 4. Replace the application containers ────────────────────────────────────────────────────
step "replace application containers"
# Old workers stop claiming and drain (SIGTERM, then the service's stop_grace_period).
dc stop worker >/dev/null 2>&1 || true
has_profile laya && { dc stop worker-laya >/dev/null 2>&1 || true; }
dc stop api >/dev/null 2>&1 || true
has_profile translate && { dc up -d --no-deps --no-build libretranslate >/dev/null || die "libretranslate did not start"; }
[ "$REHEARSAL" = 1 ] && { dc up -d --no-deps --no-build mailpit >/dev/null || die "the mail catcher did not start"; }
# The S3-compatible stand-in for the off-site bucket (backup.sh / restore-test.sh rehearsal).
if [ "$REHEARSAL" = 1 ]; then
  dc up -d --no-deps --no-build --wait --wait-timeout 120 minio >/dev/null || die "the S3 stand-in (minio) did not become healthy"
  if [ "$(envfile_get BACKUP_S3_ENDPOINT)" = "http://minio:9000" ]; then
    dc exec -T minio mkdir -p "/data/$(envfile_get BACKUP_S3_BUCKET)" || die "could not create the bucket on the S3 stand-in"
  fi
fi
START=(api worker)
has_profile laya && START+=(worker-laya)
START_OK=1
dc up -d --no-deps --no-build --wait --wait-timeout "$SMOKE_TIMEOUT" "${START[@]}" >/dev/null 2>&1 || START_OK=0
dc up -d --no-deps --no-build caddy >/dev/null 2>&1 || START_OK=0

# ── 5. Smoke ─────────────────────────────────────────────────────────────────────────────────
PUBLIC_HOST_V="$(envfile_get PUBLIC_HOST)"
HTTPS_PORT_V="$(envfile_get HTTPS_PORT)"; HTTPS_PORT_V="${HTTPS_PORT_V:-443}"
BASE="https://$PUBLIC_HOST_V:$HTTPS_PORT_V"
CURL=(curl -sS --max-time 10 --resolve "$PUBLIC_HOST_V:$HTTPS_PORT_V:127.0.0.1")
SMOKE_TMP="$(mktemp -d)"
trap 'rm -rf "$SMOKE_TMP"' EXIT
SMOKE_FAIL=""
MAINTENANCE="$ROOT/infra/scripts/maintenance.sh"
# Maintenance mode left on by an earlier failed deploy: the public pages answer 503 by design, so
# the page checks are left out; /api/v1/readyz is still proxied. The operator turns the mode off.
MAINT_AT_START=0
if [ -x "$MAINTENANCE" ] && [ "$("$MAINTENANCE" --env-file "$ENV_FILE" status 2>/dev/null || true)" = "maintenance: on" ]; then
  MAINT_AT_START=1
  echo "deploy: maintenance mode is on (an earlier deploy left it on); it stays on until: infra/scripts/maintenance.sh --env-file $ENV_FILE off"
fi
smoke() {
  local deadline=$((SECONDS + SMOKE_TIMEOUT)) code
  # Caddy's internal CA (localhost, rehearsal): trust its root for this check only.
  case "$PUBLIC_HOST_V" in
    localhost | *.localhost)
      local caddy_id
      for _ in $(seq 30); do
        caddy_id="$(dc ps -q caddy | head -n 1)"
        [ -n "$caddy_id" ] && docker cp "$caddy_id:/data/caddy/pki/authorities/local/root.crt" "$SMOKE_TMP/ca.crt" >/dev/null 2>&1 && break
        sleep 1
      done
      [ -s "$SMOKE_TMP/ca.crt" ] || { SMOKE_FAIL="the internal CA root was not produced"; return 1; }
      CURL+=(--cacert "$SMOKE_TMP/ca.crt")
      ;;
  esac
  step "readyz (waiting up to ${SMOKE_TIMEOUT} s)"
  while :; do
    code="$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/api/v1/readyz" 2>/dev/null || true)"
    [ "$code" = 200 ] && break
    [ "$SECONDS" -lt "$deadline" ] || { SMOKE_FAIL="/api/v1/readyz answered ${code:-none} within ${SMOKE_TIMEOUT} s"; return 1; }
    sleep 2
  done
  echo "smoke: /api/v1/readyz 200"
  local asset
  if [ "$MAINT_AT_START" = 1 ]; then
    echo "smoke: login page and static asset checks left out while maintenance mode is on"
  else
    code="$("${CURL[@]}" -o "$SMOKE_TMP/login.html" -w '%{http_code}' "$BASE/login" 2>/dev/null || true)"
    { [ "$code" = 200 ] && grep -qi '<html' "$SMOKE_TMP/login.html"; } || { SMOKE_FAIL="the login page answered ${code:-none}"; return 1; }
    echo "smoke: login page 200"
    asset="$(grep -oE '/assets/[A-Za-z0-9._~-]+\.(js|css)' "$SMOKE_TMP/login.html" | head -n 1 || true)"
    [ -n "$asset" ] || { SMOKE_FAIL="index.html references no static asset"; return 1; }
    code="$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE$asset" 2>/dev/null || true)"
    [ "$code" = 200 ] || { SMOKE_FAIL="the static asset $asset answered ${code:-none}"; return 1; }
    echo "smoke: static asset 200"
  fi
  for svc in worker $(has_profile laya && echo worker-laya); do
    while :; do
      state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$(dc ps -q "$svc" | head -n 1)" 2>/dev/null || echo none)"
      [ "$state" = healthy ] && break
      [ "$SECONDS" -lt "$deadline" ] || { SMOKE_FAIL="$svc heartbeat check is $state"; return 1; }
      sleep 2
    done
    echo "smoke: $svc heartbeat healthy"
  done
  smoke_queue
}

# Outbox dispatch and one queue traversal (spec 11 §3 step 5). The smoke writes a `house.purge-auth`
# intent into the outbox as the database superuser; the worker's relay must deliver it (outbox
# dispatch) and the queue must run the handler (queue traversal). In a rehearsal an expired
# rate-limit bucket is planted as the fixture and the handler must delete it; in production no
# fixture row is written and the pg-boss job must complete.
smoke_queue() {
  local QUEUE_JOB_TIMEOUT_S="${DEPLOY_QUEUE_SMOKE_TIMEOUT_S:-330}"
  local key="deploy-smoke-$STAMP" since id deadline_q fixture="" gone
  psq() { dc exec -T postgres psql -U postgres -d bantoozi -X -tAq -v ON_ERROR_STOP=1 "$@" 2>/dev/null | tr -d '\r'; }
  since="$(psq -c "select to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')")" || true
  [ -n "$since" ] || { SMOKE_FAIL="the smoke could not read the database clock"; return 1; }
  if [ "$REHEARSAL" = 1 ]; then
    fixture="$key-bucket"
    psq -c "insert into rate_limit_buckets (key, window_start, hits) values ('$fixture', now() - interval '40 days', 1)" >/dev/null ||
      { SMOKE_FAIL="the smoke fixture row could not be written"; return 1; }
  fi
  id="$(psq -c "insert into job_outbox (queue, payload, dedupe_key) values ('house.purge-auth', '{}', '$key') returning id" | head -n 1)" || true
  [[ "$id" =~ ^[0-9]+$ ]] || { SMOKE_FAIL="the smoke outbox intent could not be written"; return 1; }
  deadline_q=$((SECONDS + 60))
  # Delivery is expected within 60 s; the handler runs up to its own budget (HOUSE_RUN_BUDGET_MS, 5 min)
  # so job completion gets that plus a margin.
  deadline_job=$((SECONDS + QUEUE_JOB_TIMEOUT_S))
  until [ "$(psq -c "select delivered_at is not null from job_outbox where id = $id")" = t ]; do
    [ "$SECONDS" -lt "$deadline_q" ] || { SMOKE_FAIL="the outbox intent $id was not delivered within 60 s"; return 1; }
    sleep 2
  done
  echo "smoke: outbox dispatch ok (intent $id delivered to the queue)"
  until [ "$(psq -c "select count(*) from pgboss.job where name = 'house.purge-auth' and state = 'completed' and created_on >= '$since'")" -ge 1 ]; do
    [ "$SECONDS" -lt "$deadline_job" ] || { SMOKE_FAIL="the house.purge-auth job of the smoke did not complete within ${QUEUE_JOB_TIMEOUT_S} s"; return 1; }
    sleep 2
  done
  if [ -n "$fixture" ]; then
    gone="$(psq -c "select count(*) from rate_limit_buckets where key = '$fixture'")"
    [ "$gone" = 0 ] || { SMOKE_FAIL="the queue ran house.purge-auth but the smoke fixture row is still there"; return 1; }
    echo "smoke: queue traversal ok (fixture rate-limit bucket purged by house.purge-auth: outbox, pg-boss, worker)"
  else
    echo "smoke: queue traversal ok (house.purge-auth job completed: outbox, pg-boss, worker; the fixture row is written only in a rehearsal)"
  fi
}
if [ "$START_OK" = 1 ] && smoke; then SMOKE_OK=1; else SMOKE_OK=0; [ -n "$SMOKE_FAIL" ] || SMOKE_FAIL="an application container did not become healthy"; fi

# ── 6. Roll back the application images on failure ──────────────────────────────────────────
if [ "$SMOKE_OK" != 1 ]; then
  echo "deploy: SMOKE FAILED: $SMOKE_FAIL" >&2
  for svc in api worker; do dc logs --no-color --tail 15 "$svc" 2>&1 | sed "s/^/  $svc: /" >&2 || true; done
  restored=0
  PREV_COMMIT=""
  for svc in "${APP_SERVICES[@]}"; do
    if [ -n "${PREV_ID[$svc]:-}" ]; then
      docker tag "${PREV_ID[$svc]}" "${PREV_NAME[$svc]}" >/dev/null
      dc up -d --no-deps --no-build --force-recreate "$svc" >/dev/null 2>&1 || echo "deploy: could not restart previous $svc" >&2
      restored=1
      [ -n "$PREV_COMMIT" ] || PREV_COMMIT="${PREV_SHA[$svc]:-}"
      echo "deploy: restored previous $svc image ${PREV_ID[$svc]#sha256:}" >&2
    fi
  done
  if [ "$restored" = 1 ]; then
    echo "deploy: requested $REF (${COMMIT:0:12}) failed its smoke; restored previous images of ${PREV_COMMIT:-unknown commit} — the requested release is NOT running" >&2
  fi
  if [ "$restored" = 0 ]; then
    dc stop "${APP_SERVICES[@]}" >/dev/null 2>&1 || true
    echo "deploy: no previous images exist (first deploy): application containers stopped" >&2
  fi
  # Compatibility is demonstrated only when the restored application containers report healthy
  # against the expanded schema (spec 11 §3 step 6); otherwise the site stays in maintenance mode.
  COMPATIBLE=0
  if [ "$restored" = 1 ]; then
    recheck_deadline=$((SECONDS + (SMOKE_TIMEOUT < 90 ? SMOKE_TIMEOUT : 90)))
    COMPATIBLE=1
    for svc in api worker $(has_profile laya && echo worker-laya); do
      until [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$(dc ps -q "$svc" | head -n 1)" 2>/dev/null || echo none)" = healthy ]; do
        if [ "$SECONDS" -ge "$recheck_deadline" ]; then COMPATIBLE=0; break 2; fi
        sleep 2
      done
    done
  fi
  if [ "$COMPATIBLE" = 1 ]; then
    echo "deploy: the restored images (${PREV_COMMIT:-unknown commit}) are healthy against the expanded schema; $REF is NOT running" >&2
  else
    echo "deploy: compatibility with the expanded schema is not demonstrated: switching maintenance mode on" >&2
    if [ -x "$MAINTENANCE" ] && "$MAINTENANCE" --env-file "$ENV_FILE" on >&2; then
      echo "deploy: maintenance mode is ON (503 page); turn it off after the site is verified: infra/scripts/maintenance.sh --env-file $ENV_FILE off; recovery runbook: docs/RUNBOOK.md" >&2
    else
      echo "deploy: could not switch maintenance mode on: run infra/scripts/maintenance.sh --env-file $ENV_FILE on" >&2
    fi
  fi
  echo "deploy: the expanded schema is kept; do not reverse migrations or restore the database over writes made after the deploy (spec 11 §3 step 6)" >&2
  echo "deploy: log $LOG" >&2
  exit 1
fi

# ── Deploy log ───────────────────────────────────────────────────────────────────────────────
SCHEMA_AFTER="$(dc exec -T postgres psql -U postgres -d bantoozi -tAc 'select count(*) from drizzle.__drizzle_migrations' 2>/dev/null | tr -d '[:space:]' || true)"
echo "deploy: release=$REF commit=$COMMIT schema=${SCHEMA_BEFORE:-none}->${SCHEMA_AFTER:-?}"
for svc in "${APP_SERVICES[@]}"; do
  echo "deploy: image $svc ${NEW_ID[$svc]#sha256:} (previous ${PREV_ID[$svc]:-none})"
done
echo "deploy: OK; log $LOG"
