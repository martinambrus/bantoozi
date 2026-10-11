#!/usr/bin/env bash
# Deploy a release to the single production host (spec 11 §3).
#
#   infra/scripts/deploy.sh [--env-file <file>] [--local-rehearsal] <git-ref>
#
# Steps: lock and clean checkout -> build immutable images (frozen lockfile) -> validate the
# environment -> Postgres healthy -> migration job (exit 0 required) -> seed job (exit 0) -> replace
# the application containers -> smoke (up to 120 s) -> deploy log with the image ids. If the smoke
# fails, the previous application images are restored and the script exits non-zero.
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
  echo "deploy: local rehearsal: skipping the release-tag requirement and the pre-deploy backup precondition"
  [ "$DIRTY" -eq 0 ] || echo "deploy: local rehearsal: the working tree has $DIRTY uncommitted path(s); building the working tree as is"
else
  [[ "$REF" =~ ^v[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[0-9]+$ ]] || die "production deploys take a release tag vYYYY.MM.DD-N, got: $REF"
  [ "$DIRTY" -eq 0 ] || die "the checkout is not clean ($DIRTY uncommitted path(s))"
fi
echo "deploy: project=$PROJECT commit=${COMMIT:0:12} mode=$([ "$REHEARSAL" = 1 ] && echo local-rehearsal || echo production)"

# ── 2. Validate the environment, the profiles and the host ───────────────────────────────────
REQUIRED=(PUBLIC_HOST ACME_EMAIL PUBLIC_BASE_URL POSTGRES_PASSWORD BANTOOZI_OWNER_PASSWORD
  BANTOOZI_APP_PASSWORD BANTOOZI_WORKER_PASSWORD SESSION_PEPPER METRICS_TOKEN TYPESAFE_MODEL
  MAIL_TRANSPORT SMTP_URL)
missing=()
placeholder=()
for v in "${REQUIRED[@]}"; do
  val="$(envfile_get "$v")"
  if [ -z "$val" ]; then missing+=("$v"); continue; fi
  case "$val" in change-me* | *change-me* | *example.com*) [ "$REHEARSAL" = 1 ] || placeholder+=("$v") ;; esac
done
if [ "${#missing[@]}" -gt 0 ]; then die "required variables missing or empty in the env file: ${missing[*]}"; fi
if [ "${#placeholder[@]}" -gt 0 ]; then die "variables still hold placeholder values: ${placeholder[*]}"; fi
if [ "$(envfile_get MAIL_TRANSPORT)" != smtp ]; then die "MAIL_TRANSPORT must be smtp in production"; fi
pw_dupes="$(for v in POSTGRES_PASSWORD BANTOOZI_OWNER_PASSWORD BANTOOZI_APP_PASSWORD BANTOOZI_WORKER_PASSWORD; do envfile_get "$v"; echo; done | grep -v '^$' | sort | uniq -d | wc -l)"
[ "$pw_dupes" -eq 0 ] || die "the database passwords must be distinct"
modes="$(envfile_get LANGUAGE_MODES)"
if { [[ "$modes" == *translate* ]] || [ "$(envfile_get CARD_TEXT_MODE)" = english ]; } && ! has_profile translate; then
  die "LANGUAGE_MODES asks for translation: enable the translate profile (COMPOSE_PROFILES=translate)"
fi
# Static connection budget (spec 11 §2): API 10 + worker 24 (+ worker-laya 6), pg-boss, migration and
# backup connections reserved at 20; the combined maximum stays below 80.
BUDGET=$((10 + 24 + 20))
if has_profile laya; then BUDGET=$((BUDGET + 6 + 24)); fi
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
declare -A PREV_ID PREV_NAME
for svc in "${APP_SERVICES[@]}"; do
  cid="$(dc ps -aq "$svc" 2>/dev/null | head -n 1 || true)"
  if [ -n "$cid" ]; then
    PREV_ID[$svc]="$(docker inspect -f '{{.Image}}' "$cid")"
    PREV_NAME[$svc]="$(docker inspect -f '{{.Config.Image}}' "$cid")"
    docker tag "${PREV_ID[$svc]}" "${PREV_NAME[$svc]%%:*}:previous" >/dev/null
    echo "deploy: previous $svc image ${PREV_ID[$svc]#sha256:}"
  else
    echo "deploy: previous $svc image none (first deploy)"
  fi
done
SCHEMA_BEFORE="$(dc exec -T postgres psql -U postgres -d bantoozi -tAc 'select count(*) from drizzle.__drizzle_migrations' 2>/dev/null | tr -d '[:space:]' || true)"
echo "deploy: schema version before: ${SCHEMA_BEFORE:-none}"

if [ "$REHEARSAL" = 1 ]; then
  echo "deploy: local rehearsal: pre-deploy backup skipped"
else
  BACKUP="$ROOT/infra/scripts/backup.sh"
  [ -x "$BACKUP" ] || die "the pre-deploy backup is required (spec 11 §3 step 2) but $BACKUP does not exist yet"
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
[ "$REHEARSAL" = 1 ] && { dc up -d --no-deps --no-build minio >/dev/null || die "the S3 stand-in (minio) did not start"; }
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
  code="$("${CURL[@]}" -o "$SMOKE_TMP/login.html" -w '%{http_code}' "$BASE/login" 2>/dev/null || true)"
  { [ "$code" = 200 ] && grep -qi '<html' "$SMOKE_TMP/login.html"; } || { SMOKE_FAIL="the login page answered ${code:-none}"; return 1; }
  echo "smoke: login page 200"
  local asset
  asset="$(grep -oE '/assets/[A-Za-z0-9._~-]+\.(js|css)' "$SMOKE_TMP/login.html" | head -n 1 || true)"
  [ -n "$asset" ] || { SMOKE_FAIL="index.html references no static asset"; return 1; }
  code="$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE$asset" 2>/dev/null || true)"
  [ "$code" = 200 ] || { SMOKE_FAIL="the static asset $asset answered ${code:-none}"; return 1; }
  echo "smoke: static asset 200"
  for svc in worker $(has_profile laya && echo worker-laya); do
    while :; do
      state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$(dc ps -q "$svc" | head -n 1)" 2>/dev/null || echo none)"
      [ "$state" = healthy ] && break
      [ "$SECONDS" -lt "$deadline" ] || { SMOKE_FAIL="$svc heartbeat check is $state"; return 1; }
      sleep 2
    done
    echo "smoke: $svc heartbeat healthy"
  done
  if [ "$REHEARSAL" = 1 ]; then
    echo "smoke: outbox dispatch and the fixture-backed queue traversal are skipped in the local rehearsal"
  else
    echo "smoke: WARNING outbox dispatch and the fixture-backed queue traversal are not implemented yet"
  fi
}
if [ "$START_OK" = 1 ] && smoke; then SMOKE_OK=1; else SMOKE_OK=0; [ -n "$SMOKE_FAIL" ] || SMOKE_FAIL="an application container did not become healthy"; fi

# ── 6. Roll back the application images on failure ──────────────────────────────────────────
if [ "$SMOKE_OK" != 1 ]; then
  echo "deploy: SMOKE FAILED: $SMOKE_FAIL" >&2
  for svc in api worker; do dc logs --no-color --tail 15 "$svc" 2>&1 | sed "s/^/  $svc: /" >&2 || true; done
  restored=0
  for svc in "${APP_SERVICES[@]}"; do
    if [ -n "${PREV_ID[$svc]:-}" ]; then
      docker tag "${PREV_ID[$svc]}" "${PREV_NAME[$svc]}" >/dev/null
      dc up -d --no-deps --no-build --force-recreate "$svc" >/dev/null 2>&1 || echo "deploy: could not restart previous $svc" >&2
      restored=1
      echo "deploy: restored previous $svc image ${PREV_ID[$svc]#sha256:}" >&2
    fi
  done
  if [ "$restored" = 0 ]; then
    dc stop "${APP_SERVICES[@]}" >/dev/null 2>&1 || true
    echo "deploy: no previous images exist (first deploy): application containers stopped" >&2
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
