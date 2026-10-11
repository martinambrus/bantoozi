#!/usr/bin/env bash
# Restore drill: restores an off-site backup into an isolated throwaway Postgres 16 and verifies it
# (spec 11 §4, §4.1, §5.1).
#
#   infra/scripts/restore-test.sh --env-file <file> --identity <age identity file> [--backup-id <id>]
#
# The identity (the offline recovery key) and the separately recovered key material
# (PROVIDER_MASTER_KEY_ID/PROVIDER_MASTER_KEYS, DELETION_HMAC_KEY) come from the operator, not from
# the backup. The default backup is the newest valid one. Steps: fetch and decrypt the manifest;
# start an empty postgres:16 container with NO network (no egress, no published port); restore the
# globals (psql, ON_ERROR_STOP) and the database (pg_restore --exit-on-error --create) from the
# decrypted stream, which only ever passes through pipes; verify schemas, extensions, migration
# count, foreign keys, sequences, active seeds, manifest bounds, role separation, row-level
# security with two fixture tenants, the cold bookmarked snapshots (checksum, no refetch) and the
# provider credentials (decrypted with the recovered keys, accepted by an in-process fake
# provider); replay the deletion ledger and revoke restored sessions and login codes. On success it
# marks the backup restore-tested in the bucket, prints the report and posts `restore_ok`; on any
# failure it prints nothing as verified, exits non-zero and posts `restore_failed`. The throwaway
# container and its volume are removed on every exit.
set -euo pipefail

# shellcheck source=infra/scripts/ops-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/ops-lib.sh"

ENV_FILE="${BANTOOZI_ENV_FILE:-}"
IDENTITY=""
BACKUP_ID_ARG=""
usage() { echo "usage: restore-test.sh --env-file <file> --identity <age identity file> [--backup-id <id>]" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) [ $# -ge 2 ] || usage; ENV_FILE="$2"; shift 2 ;;
    --env-file=*) ENV_FILE="${1#--env-file=}"; shift ;;
    --identity) [ $# -ge 2 ] || usage; IDENTITY="$2"; shift 2 ;;
    --identity=*) IDENTITY="${1#--identity=}"; shift ;;
    --backup-id) [ $# -ge 2 ] || usage; BACKUP_ID_ARG="$2"; shift 2 ;;
    --backup-id=*) BACKUP_ID_ARG="${1#--backup-id=}"; shift ;;
    -h | --help) usage ;;
    *) echo "restore-test: unknown argument $1" >&2; usage ;;
  esac
done
[ -n "$IDENTITY" ] || usage
[ -r "$IDENTITY" ] || ops_die "cannot read the identity file"
IDENTITY="$(cd "$(dirname "$IDENTITY")" && pwd)/$(basename "$IDENTITY")"
if [ -n "$BACKUP_ID_ARG" ] && ! [[ "$BACKUP_ID_ARG" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then ops_die "--backup-id must look like YYYYMMDDTHHMMSSZ"; fi

ops_load_env
ops_workdir
START_EPOCH="$(date -u +%s)"
STAGE=init
PG_NAME=""
ID="${BACKUP_ID_ARG}"

STATE_DIR="${BACKUP_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/bantoozi/backup}"
mkdir -p "$STATE_DIR"
exec 9>"$STATE_DIR/$PROJECT.restore.lock"
if ! flock -n 9; then echo "restore-test: another restore test of $PROJECT is running" >&2; rm -rf "$WORK"; exit 75; fi

on_exit() {
  local rc=$?
  trap - EXIT
  if [ -n "$PG_NAME" ]; then docker rm -f -v "$PG_NAME" >/dev/null 2>&1 || true; fi
  if [ "$rc" -ne 0 ]; then
    local tail_text
    tail_text="$(err_tail)"
    echo "restore-test: FAILED at stage $STAGE (exit $rc)${tail_text:+: $tail_text}" >&2
    post_event restore_failed "restore test of ${ID:-no backup} failed at stage $STAGE (exit $rc) ${tail_text}" || true
  fi
  rm -rf "$WORK"
  exit "$rc"
}
trap on_exit EXIT

reader() { S3_ACCESS_KEY="$WRITER_AK" S3_SECRET_KEY="$WRITER_SK" "$@"; }
TOOLS_EXTRA=(--user "$(id -u):$(id -g)" -v "$IDENTITY:/run/bantoozi/identity:ro")

# tools_netns <tool args…> : the tools inside the network namespace of the throwaway Postgres, which
# has no other network. Only the recovered key material is handed over.
tools_netns() {
  PROVIDER_MASTER_KEY_ID="$KEY_ID" PROVIDER_MASTER_KEYS="$KEYS_JSON" DELETION_HMAC_KEY="$HMAC_KEY" \
    docker run --rm -i --name "$(uniq_name verify)" --network "container:$PG_NAME" \
    --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
    -e PROVIDER_MASTER_KEY_ID -e PROVIDER_MASTER_KEYS -e DELETION_HMAC_KEY \
    "${TOOLS_EXTRA[@]}" "$TOOLS_IMAGE" "$@" 2>>"$ERRLOG"
}
KEY_ID="$(envfile_get PROVIDER_MASTER_KEY_ID)"
KEYS_JSON="$(envfile_get PROVIDER_MASTER_KEYS)"
HMAC_KEY="$(envfile_get DELETION_HMAC_KEY)"
[ -n "$WRITER_AK" ] && [ -n "$WRITER_SK" ] || ops_die "BACKUP_S3_ACCESS_KEY/SECRET_KEY must be set"

STAGE=tools-image
ensure_tools_image

STAGE=select
[ -n "$ID" ] || ID="$(reader tools_run backup:newest)"
P="${BACKUP_S3_PREFIX}${ID}/"

STAGE=manifest
MANIFEST="$(reader tools_run backup:get "${P}manifest.age" --decrypt)"
INFO="$(printf '%s' "$MANIFEST" | tools_run backup:manifest)"
M_ID=""; M_DUMP=""; M_GLOBALS=""; BACKUP_AGE_S=""
while IFS='=' read -r key value; do
  case "$key" in
    MANIFEST_BACKUP_ID) M_ID="$value" ;;
    MANIFEST_DUMP_SHA256) M_DUMP="$value" ;;
    MANIFEST_GLOBALS_SHA256) M_GLOBALS="$value" ;;
    MANIFEST_BACKUP_AGE_S) BACKUP_AGE_S="$value" ;;
  esac
done <<<"$INFO"
[ "$M_ID" = "$ID" ] && [ -n "$M_DUMP" ] && [ -n "$M_GLOBALS" ] && [ -n "$BACKUP_AGE_S" ] || { echo "the manifest does not belong to backup $ID" >>"$ERRLOG"; false; }

STAGE=throwaway
PG_NAME="$(uniq_name restore-pg)"
# No network at all: nothing can leave the container and nothing is published. The data volume is
# anonymous and removed with the container (`docker rm -v`).
docker run -d --name "$PG_NAME" --network none -e POSTGRES_HOST_AUTH_METHOD=trust \
  --label bantoozi.restore-test=1 "$POSTGRES_IMAGE" postgres -c fsync=off -c full_page_writes=off \
  -c synchronous_commit=off >/dev/null 2>>"$ERRLOG"
ready=0
for _ in $(seq 1 90); do
  if docker exec "$PG_NAME" pg_isready -q -h 127.0.0.1 -U postgres >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || { echo "the throwaway postgres did not become ready" >>"$ERRLOG"; false; }

STAGE=restore-globals
# The new instance already has its bootstrap superuser: its role statements are skipped.
reader tools_run backup:get "${P}globals.age" --decrypt --sha256 "$M_GLOBALS" |
  grep -vE '^(CREATE|ALTER) ROLE postgres( |;)' |
  docker exec -i "$PG_NAME" psql -U postgres -X -q -v ON_ERROR_STOP=1 -f - >/dev/null 2>>"$ERRLOG"

STAGE=restore-database
reader tools_run backup:get "${P}dump.age" --decrypt --sha256 "$M_DUMP" |
  docker exec -i "$PG_NAME" pg_restore -U postgres --exit-on-error --create -d postgres 2>>"$ERRLOG"

STAGE=verify
VERIFY_OUT="$(printf '%s' "$MANIFEST" | tools_netns restore:verify)"

STAGE=ledger
LEDGER="$(reader tools_run ledger:fetch)"
REPLAY_OUT="$(printf '%s\n' "$LEDGER" | tools_netns ledger:replay)"

STAGE=mark
DURATION=$(( $(date -u +%s) - START_EPOCH ))
printf '{"ok":true,"restoredAt":"%s","durationS":%s,"backupAgeS":%s}' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$DURATION" "$BACKUP_AGE_S" |
  reader tools_run backup:put-raw "${P}restore-tested.json" >/dev/null

STAGE=event
printf '%s\n' "$VERIFY_OUT"
printf '%s\n' "$REPLAY_OUT"
echo "BACKUP_ID=$ID"
echo "RESTORE_DURATION_S=$DURATION"
echo "BACKUP_AGE_S=$BACKUP_AGE_S"
if ! post_event restore_ok "restore of $ID ok duration_s=$DURATION backup_age_s=$BACKUP_AGE_S $(printf '%s' "$REPLAY_OUT" | cut -c1-200)"; then
  echo "restore-test: warning: the restore is verified but restore_ok could not be recorded: $(err_tail)" >&2
fi
STAGE=done
