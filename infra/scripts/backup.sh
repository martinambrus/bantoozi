#!/usr/bin/env bash
# Encrypted off-site backup of the production database (spec 11 §4).
#
#   infra/scripts/backup.sh --env-file <file> [--pre-deploy]
#   infra/scripts/backup.sh --env-file <file> --prune-only [--now <iso>]
#
# Under a host lock: `pg_dump -Fc` and `pg_dumpall --globals-only --no-role-passwords` as the
# database superuser (PostgreSQL 16 client of the pinned postgres image) are streamed into age
# (recipient BACKUP_AGE_RECIPIENT) and into the S3-compatible bucket; nothing is written to disk in
# the clear. A manifest (UTC start/end, commit, image ids, schema version, ciphertext checksums,
# row-count bounds) is encrypted and uploaded LAST: a backup without its manifest is not a backup
# and is never offered to a restore. Each object is verified (size and checksum read back) before
# `backup_ok` is posted; the deletion ledger is shipped with every backup. Retention (7 daily,
# 4 weekly, 6 monthly, by the UTC id, never the last restore-tested backup) is applied only after
# the new backup is verified, with the separate delete credentials; the routine writer credentials
# cannot delete. On any failure the script exits non-zero and posts `backup_failed`.
#
# --pre-deploy   the backup deploy.sh takes before the migration (same backup, labelled as such)
# --prune-only   no backup: apply the retention policy (--now overrides the clock, for tests)
# Env file keys: COMPOSE_PROJECT_NAME, BACKUP_S3_ENDPOINT/BUCKET/PREFIX/REGION,
# BACKUP_S3_ACCESS_KEY/SECRET_KEY (writer), BACKUP_S3_PRUNE_ACCESS_KEY/SECRET_KEY (retention),
# BACKUP_AGE_RECIPIENT, DELETION_LEDGER_PATH (inside the worker container).
set -euo pipefail

# shellcheck source=infra/scripts/ops-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/ops-lib.sh"

ENV_FILE="${BANTOOZI_ENV_FILE:-}"
PRE_DEPLOY=0
PRUNE_ONLY=0
NOW_ISO=""
usage() { echo "usage: backup.sh --env-file <file> [--pre-deploy | --prune-only [--now <iso>]]" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) [ $# -ge 2 ] || usage; ENV_FILE="$2"; shift 2 ;;
    --env-file=*) ENV_FILE="${1#--env-file=}"; shift ;;
    --pre-deploy) PRE_DEPLOY=1; shift ;;
    --prune-only) PRUNE_ONLY=1; shift ;;
    --now) [ $# -ge 2 ] || usage; NOW_ISO="$2"; shift 2 ;;
    --now=*) NOW_ISO="${1#--now=}"; shift ;;
    -h | --help) usage ;;
    *) echo "backup: unknown argument $1" >&2; usage ;;
  esac
done
[ "$PRE_DEPLOY" = 0 ] || [ "$PRUNE_ONLY" = 0 ] || usage

ops_load_env
ops_workdir
[ -n "$NOW_ISO" ] || NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ID="$(date -u -d "$NOW_ISO" +%Y%m%dT%H%M%SZ 2>/dev/null)" || ops_die "--now is not a date: $NOW_ISO"
P="${BACKUP_S3_PREFIX}${ID}/"
STAGE=init
MAY_HAVE_PARTS=0
STARTED_EPOCH="$(date -u +%s)"
# Same literal as ERASURE_BACKUP_LOCK_KEY in packages/shared/src/erasure-lock.ts (a test compares them).
ERASURE_BACKUP_LOCK_KEY=7340026011
ERASURE_LOCK_WAIT_S="${BACKUP_ERASURE_LOCK_WAIT_S:-300}"
LOCK_PID=""

# Host lock: one backup (or prune) at a time per project.
STATE_DIR="${BACKUP_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/bantoozi/backup}"
mkdir -p "$STATE_DIR"
exec 9>"$STATE_DIR/$PROJECT.backup.lock"
if ! flock -n 9; then echo "backup: another backup of $PROJECT is running" >&2; rm -rf "$WORK"; exit 75; fi

# Erasure/backup lock (spec 11 §4, §5.1): a psql session in the postgres container holds the advisory
# lock that house.purge-users takes around each user's ledger append + hard delete, from before pg_dump
# until the ledger copy is shipped. The session lives as long as its stdin fifo (fd 7) stays open;
# closing the fd (or the container exec dying) releases the lock. The wait is bounded by
# lock_timeout, so a stuck purge fails the backup (backup_failed) instead of hanging it.
acquire_erasure_lock() {
  local fifo="$WORK/erasure-lock.in" out="$WORK/erasure-lock.out" waited=0
  mkfifo "$fifo"
  : > "$out"
  dc exec -T postgres psql -U postgres -d bantoozi -X -tA -v ON_ERROR_STOP=1 <"$fifo" >"$out" 2>>"$ERRLOG" &
  LOCK_PID=$!
  exec 7<>"$fifo"
  printf "SET lock_timeout = '%ss';\nSELECT pg_advisory_lock(%s);\nSELECT 'ERASURE_LOCKED';\n" \
    "$ERASURE_LOCK_WAIT_S" "$ERASURE_BACKUP_LOCK_KEY" >&7
  while ! grep -q ERASURE_LOCKED "$out" 2>/dev/null; do
    if ! kill -0 "$LOCK_PID" 2>/dev/null; then
      echo "could not take the erasure lock (a purge holds it or the session failed)" >>"$ERRLOG"
      LOCK_PID=""
      exec 7>&-
      return 1
    fi
    waited=$((waited + 1))
    if [ "$waited" -gt $(( (ERASURE_LOCK_WAIT_S + 30) * 5 )) ]; then
      echo "timed out waiting for the erasure lock" >>"$ERRLOG"
      release_erasure_lock
      return 1
    fi
    sleep 0.2
  done
}
release_erasure_lock() {
  exec 7>&- || true
  if [ -n "$LOCK_PID" ]; then
    wait "$LOCK_PID" 2>/dev/null || true
    LOCK_PID=""
  fi
}

on_exit() {
  local rc=$?
  trap - EXIT
  release_erasure_lock
  if [ "$rc" -ne 0 ]; then
    local tail_text
    tail_text="$(err_tail)"
    echo "backup: FAILED at stage $STAGE (exit $rc)${tail_text:+: $tail_text}" >&2
    if [ "$PRUNE_ONLY" = 0 ]; then
      if [ "$MAY_HAVE_PARTS" = 1 ]; then
        # Best effort: tell the retention job that the objects of this id are leftovers.
        printf '{"failed":true}' | S3_ACCESS_KEY="$WRITER_AK" S3_SECRET_KEY="$WRITER_SK" \
          tools_run backup:put-raw "${P}backup-failed" >/dev/null 2>&1 || true
      fi
      post_event backup_failed "backup $ID failed at stage $STAGE (exit $rc) ${tail_text}" || true
    fi
  fi
  rm -rf "$WORK"
  exit "$rc"
}
trap on_exit EXIT

writer() { S3_ACCESS_KEY="$WRITER_AK" S3_SECRET_KEY="$WRITER_SK" "$@"; }
pruner() { S3_ACCESS_KEY="$PRUNE_AK" S3_SECRET_KEY="$PRUNE_SK" "$@"; }
psql_su() { dc exec -T postgres psql -U postgres -d bantoozi -X -tA "$@" 2>>"$ERRLOG"; }

STAGE=tools-image
ensure_tools_image

if [ "$PRUNE_ONLY" = 1 ]; then
  STAGE=prune
  [ -n "$PRUNE_AK" ] && [ -n "$PRUNE_SK" ] || ops_die "BACKUP_S3_PRUNE_ACCESS_KEY/SECRET_KEY must be set"
  pruner tools_run backup:prune --now "$NOW_ISO"
  exit 0
fi

[ -n "$WRITER_AK" ] && [ -n "$WRITER_SK" ] || ops_die "BACKUP_S3_ACCESS_KEY/SECRET_KEY must be set"
case "$BACKUP_AGE_RECIPIENT" in age1*) ;; *) ops_die "BACKUP_AGE_RECIPIENT must be an age recipient (age1…)" ;; esac

STAGE=bucket-check
writer tools_run backup:check >/dev/null

STAGE=facts
SCHEMA_VERSION="$(psql_su -c 'select count(*) from drizzle.__drizzle_migrations' | tr -d '[:space:]')"
BOUNDS="$(psql_su -c "select json_build_object('users',(select count(*) from users),'feeds',(select count(*) from feeds),'subscriptions',(select count(*) from subscriptions),'articles',(select count(*) from articles),'article_snapshots',(select count(*) from article_snapshots),'user_article',(select count(*) from user_article),'waitlist',(select count(*) from waitlist),'invites',(select count(*) from invites))" | tr -d '\n')"
[[ "$SCHEMA_VERSION" =~ ^[0-9]+$ ]] || { echo "could not read the schema version" >>"$ERRLOG"; false; }
COMMIT="$(git -C "$OPS_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
IMAGES=""
for svc in postgres api worker; do
  cid="$(dc ps -q "$svc" 2>/dev/null | head -n 1 || true)"
  img="unknown"
  [ -z "$cid" ] || img="$(docker inspect -f '{{.Image}}' "$cid" 2>/dev/null || echo unknown)"
  IMAGES="${IMAGES:+$IMAGES,}\"$svc\":\"$img\""
done
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Serialize with house.purge-users from before the dump snapshot until the ledger copy is shipped: a
# purge is then wholly before (user absent from the dump, tombstone in the copy) or wholly after
# (user still in the dump, deleted_at set) this backup, never straddling it.
STAGE=erasure-lock
acquire_erasure_lock

STAGE=dump
MAY_HAVE_PARTS=1
DUMP_JSON="$(dc exec -T postgres pg_dump -U postgres -Fc bantoozi 2>>"$ERRLOG" |
  writer tools_run backup:put "${P}dump.age")"
STAGE=globals
GLOBALS_JSON="$(dc exec -T postgres pg_dumpall -U postgres --globals-only --no-role-passwords 2>>"$ERRLOG" |
  writer tools_run backup:put "${P}globals.age")"

# The ledger copy is shipped and verified (put-raw checks size and checksum) before the manifest, which
# stays the final commit point; a ledger failure fails the backup.
STAGE=ledger
LEDGER_NOTE="ledger=not-configured"
if [ -n "$LEDGER_PATH" ]; then
  ledger_cmd() {
    if [ -n "$(dc ps -q --status running worker 2>/dev/null | head -n 1)" ]; then
      dc exec -T worker "$@"
    else
      dc run --rm -T --no-deps --entrypoint "$1" worker "${@:2}"
    fi
  }
  if ledger_cmd test -f "$LEDGER_PATH" 2>>"$ERRLOG"; then
    ledger_cmd cat "$LEDGER_PATH" 2>>"$ERRLOG" |
      writer tools_run backup:put-raw "${BACKUP_S3_LEDGER_PREFIX}deletion-ledger-${ID}.age" >/dev/null
    LEDGER_NOTE="ledger=shipped"
  else
    LEDGER_NOTE="ledger=none-yet"
  fi
fi

release_erasure_lock

STAGE=manifest
FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
MANIFEST="{\"version\":1,\"backupId\":\"$ID\",\"startedAt\":\"$STARTED_AT\",\"finishedAt\":\"$FINISHED_AT\",\"commit\":\"$COMMIT\",\"preDeploy\":$([ "$PRE_DEPLOY" = 1 ] && echo true || echo false),\"schemaVersion\":$SCHEMA_VERSION,\"images\":{$IMAGES},\"bounds\":$BOUNDS,\"objects\":[$DUMP_JSON,$GLOBALS_JSON]}"
printf '%s' "$MANIFEST" | writer tools_run backup:put "${P}manifest.age" >/dev/null

STAGE=prune
PRUNE_NOTE="prune=skipped"
if [ -n "$PRUNE_AK" ] && [ -n "$PRUNE_SK" ]; then
  if PRUNE_OUT="$(pruner tools_run backup:prune --now "$NOW_ISO")"; then
    PRUNE_NOTE="prune=ok ${PRUNE_OUT#PRUNE }"
  else
    PRUNE_NOTE="prune=FAILED"
    echo "backup: warning: retention pruning failed; the backup itself is verified" >&2
  fi
fi

STAGE=event
DURATION=$(( $(date -u +%s) - STARTED_EPOCH ))
DETAIL="backup $ID ok$([ "$PRE_DEPLOY" = 1 ] && echo ' pre-deploy') schema=$SCHEMA_VERSION dump_bytes=$(json_field "$DUMP_JSON" size) duration_s=$DURATION $LEDGER_NOTE $PRUNE_NOTE"
if ! post_event backup_ok "$DETAIL"; then
  echo "backup: warning: the backup is verified but backup_ok could not be recorded: $(err_tail)" >&2
fi
echo "BACKUP_ID=$ID"
echo "backup: ok $(redact "$DETAIL")"
STAGE=done
