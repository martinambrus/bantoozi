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
# provider); replay the deletion ledger and revoke restored sessions and login codes; run
# `recovery:prepare` (spec 11 §4.1 step 4); set the three role passwords (`recovery:role-passwords`, spec 11
# §4 step 3) and prove each role logs in over scram-authenticated loopback TCP; then start the SAVED RELEASE (the api and worker image
# ids recorded in the manifest) against the restore and run the login/read/rank/outbox smoke
# (spec 11 §4), printing `RELEASE_SMOKE login=ok read=ok rank=ok outbox=ok`. The release containers
# have no network at all (`--network none`): they reach the throwaway Postgres through its unix
# socket directory, mail goes to a sink inside the api container, and no provider key is set. On
# success it marks the backup restore-tested in the bucket, prints the report and posts
# `restore_ok`; on any failure (a smoke step that is not ok included) it prints nothing as verified,
# exits non-zero and posts `restore_failed`. The throwaway containers and their volumes are removed
# on every exit.
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
API_NAME=""
WORKER_NAME=""
ID="${BACKUP_ID_ARG}"

STATE_DIR="${BACKUP_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/bantoozi/backup}"
mkdir -p "$STATE_DIR"
exec 9>"$STATE_DIR/$PROJECT.restore.lock"
if ! flock -n 9; then echo "restore-test: another restore test of $PROJECT is running" >&2; rm -rf "$WORK"; exit 75; fi

on_exit() {
  local rc=$?
  trap - EXIT
  for name in "$WORKER_NAME" "$API_NAME"; do
    if [ -n "$name" ]; then docker rm -f -v "$name" >/dev/null 2>&1 || true; fi
  done
  if [ -n "$PG_NAME" ]; then
    # The postgres entrypoint hands the shared socket directory to its own user: the socket files go first.
    docker exec "$PG_NAME" sh -c 'rm -f /var/run/postgresql/.s.PGSQL.5432 /var/run/postgresql/.s.PGSQL.5432.lock' >/dev/null 2>&1 || true
    docker rm -f -v "$PG_NAME" >/dev/null 2>&1 || true
  fi
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
    -e BANTOOZI_OWNER_PASSWORD -e BANTOOZI_APP_PASSWORD -e BANTOOZI_WORKER_PASSWORD \
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
# anonymous and removed with the container (`docker rm -v`). The unix socket directory is shared
# with the release containers of the smoke stage (they have no network either).
SOCK_DIR="$WORK/pgsock"
mkdir "$SOCK_DIR"; chmod 777 "$SOCK_DIR"
docker run -d --name "$PG_NAME" --network none -e POSTGRES_HOST_AUTH_METHOD=trust \
  -v "$SOCK_DIR:/var/run/postgresql" \
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

STAGE=recovery-prepare
# Spec 11 §4.1 step 4: the new workers must not resume a restored job lease or relay lease.
RECOVERY_OUT="$(tools_netns recovery:prepare </dev/null)"

STAGE=role-passwords
# Spec 11 §4 step 3: the globals dump has no role passwords, so a restored cluster has three roles
# nobody can log in as. `recovery:role-passwords` sets them from the deployment secrets; here
# throwaway values stand in (the real ones never reach this run). Then the throwaway Postgres is
# made to require scram-sha-256 on every TCP connection (its socket stays trusted for the release
# smoke, which has no network) and each role must log in over loopback with its password and be
# refused with a wrong one: the roles have working passwords after a restore.
rand_pw() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
BANTOOZI_OWNER_PASSWORD="$(rand_pw)"; BANTOOZI_APP_PASSWORD="$(rand_pw)"; BANTOOZI_WORKER_PASSWORD="$(rand_pw)"
export BANTOOZI_OWNER_PASSWORD BANTOOZI_APP_PASSWORD BANTOOZI_WORKER_PASSWORD
ROLES_OUT="$(tools_netns recovery:role-passwords </dev/null)"
[ "$ROLES_OUT" = "ROLE_PASSWORDS set=3" ] || { echo "recovery:role-passwords said: $ROLES_OUT" >>"$ERRLOG"; false; }
docker exec "$PG_NAME" sh -c "sed -i -E 's/^(host[[:space:]].*)[[:space:]]trust\$/\\1 scram-sha-256/' \"\$PGDATA/pg_hba.conf\" && ! grep -E '^host.*trust' \"\$PGDATA/pg_hba.conf\"" >/dev/null 2>>"$ERRLOG" ||
  { echo "the throwaway pg_hba.conf still trusts TCP connections" >>"$ERRLOG"; false; }
docker exec "$PG_NAME" psql -U postgres -X -q -c 'select pg_reload_conf()' >/dev/null 2>>"$ERRLOG"
role_login() { # role_login <role> <password> : psql over loopback TCP, password auth only
  PGPASSWORD="$2" docker exec -e PGPASSWORD "$PG_NAME" psql -X -q -t -A -h 127.0.0.1 -U "$1" -d bantoozi -c 'select 1' 2>/dev/null
}
for pair in "bantoozi_owner:$BANTOOZI_OWNER_PASSWORD" "bantoozi_app:$BANTOOZI_APP_PASSWORD" "bantoozi_worker:$BANTOOZI_WORKER_PASSWORD"; do
  role="${pair%%:*}"; pw="${pair#*:}"
  [ "$(role_login "$role" "$pw")" = 1 ] || { echo "role $role cannot log in with its restored password" >>"$ERRLOG"; false; }
  [ -z "$(role_login "$role" "${pw}x")" ] || { echo "role $role accepts a wrong password" >>"$ERRLOG"; false; }
done
ROLE_LOGINS=ok

STAGE=release-smoke
# The saved release: the api and worker image ids the manifest recorded; the current compose images
# when this host no longer has them (said in the output).
RELEASE_SOURCE=manifest
release_image() { # release_image <service> <variable> : sets the variable to the image to run
  local id
  id="$(printf '%s' "$MANIFEST" | sed -nE "s/.*\"$1\":\"(sha256:[0-9a-f]{64})\".*/\\1/p")"
  if [ -n "$id" ] && docker image inspect "$id" >/dev/null 2>&1; then printf -v "$2" '%s' "$id"; return 0; fi
  RELEASE_SOURCE=current
  id="$(dc config --images 2>/dev/null | grep -E -- "-$1(:|$)" | head -n 1)"
  if [ -n "$id" ] && docker image inspect "$id" >/dev/null 2>&1; then printf -v "$2" '%s' "$id"; return 0; fi
  echo "no $1 image of the saved release is available" >>"$ERRLOG"
  return 1
}
API_IMAGE=""; WORKER_IMAGE=""
release_image api API_IMAGE
release_image worker WORKER_IMAGE
[ -n "$API_IMAGE" ] && [ -n "$WORKER_IMAGE" ]

SMOKE_EMAIL="release-smoke@restore-smoke.invalid"
# Throwaway values for this run only; the real tokens, peppers and keys never reach the release.
SMOKE_TOKEN="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
SMOKE_PEPPER="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
TYPESAFE_MODEL_V="$(envfile_get TYPESAFE_MODEL)"; TYPESAFE_MODEL_V="${TYPESAFE_MODEL_V:-jev-1.13.0}"

# release_start <name> <image> <smtp url> : an isolated release container. No network, read-only
# root, no capabilities. Values are handed over by name from this subshell's environment; the
# throwaway database trusts every connection on its socket.
release_start() {
  (
    export NODE_ENV=production PUBLIC_BASE_URL=https://restore-smoke.invalid MAIL_TRANSPORT=smtp
    export MAIL_FROM='Bantoozi <no-reply@restore-smoke.invalid>' TYPESAFE_MODEL="$TYPESAFE_MODEL_V"
    export METRICS_TOKEN="$SMOKE_TOKEN" LOG_LEVEL=warn ADMIN_EMAILS="$SMOKE_EMAIL" SESSION_PEPPER="$SMOKE_PEPPER"
    export SIGNUP_MODE=invite API_PORT=3000 API_HOST=127.0.0.1 WORKER_METRICS_PORT=9101
    export WORKER_METRICS_HOST=127.0.0.1 WORKER_QUEUES='*' LLM_FALLBACK_ENABLED=false DAILY_BUDGET_USD=0
    export SMTP_URL="$3"
    # A production worker refuses to start without the deletion ledger settings; these are throwaway
    # values for the isolated smoke (no network, nothing is purged here).
    export DELETION_LEDGER_PATH=/var/lib/bantoozi/ledger/deletion-ledger.age DELETION_HMAC_KEY="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    export DELETION_LEDGER_RECIPIENT=age1releasesmokethrowawayrecipientplaceholder0000000000000000000000
    export DATABASE_URL="postgres://bantoozi_app:$BANTOOZI_APP_PASSWORD@localhost/bantoozi?host=%2Fpgsock"
    export DATABASE_URL_WORKER="postgres://bantoozi_worker:$BANTOOZI_WORKER_PASSWORD@localhost/bantoozi?host=%2Fpgsock"
    docker run -d --name "$1" --network none --read-only --tmpfs /tmp --tmpfs /var/lib/bantoozi/ledger --cap-drop ALL \
      --security-opt no-new-privileges:true --label bantoozi.restore-test=1 \
      -v "$SOCK_DIR:/pgsock:ro" \
      -e NODE_ENV -e PUBLIC_BASE_URL -e MAIL_TRANSPORT -e SMTP_URL -e MAIL_FROM -e TYPESAFE_MODEL -e METRICS_TOKEN \
      -e LOG_LEVEL -e ADMIN_EMAILS -e DATABASE_URL -e DATABASE_URL_WORKER -e SESSION_PEPPER -e SIGNUP_MODE \
      -e API_PORT -e API_HOST -e WORKER_METRICS_PORT -e WORKER_METRICS_HOST -e WORKER_QUEUES \
      -e LLM_FALLBACK_ENABLED -e DAILY_BUDGET_USD \
      -e DELETION_LEDGER_PATH -e DELETION_HMAC_KEY -e DELETION_LEDGER_RECIPIENT "$2" >/dev/null 2>>"$ERRLOG"
  )
}
# The restored settings may close signup ('settings.signup_mode' beats the SIGNUP_MODE of the smoke
# environment), and a closed signup sends no code to an unknown address. So the smoke account is
# created in the throwaway database first: an existing user always gets a login code. The
# production database and the restored settings are left as they are.
docker exec -i "$PG_NAME" psql -U postgres -d bantoozi -X -q -v ON_ERROR_STOP=1 -v email="$SMOKE_EMAIL" >/dev/null 2>>"$ERRLOG" <<'SQL'
insert into users (id, email, role, plan, invites_left)
select gen_random_uuid(), :'email', 'admin', key, invites_on_signup from plans where is_default
on conflict (email) do nothing;
SQL
API_NAME="$(uniq_name restore-api)"
WORKER_NAME="$(uniq_name restore-worker)"
# Fake mail: the api sends to a sink the smoke starts inside the api container; the worker's SMTP
# address answers nothing. No provider key is set, so no inference call can be made.
release_start "$API_NAME" "$API_IMAGE" smtp://127.0.0.1:1025
release_start "$WORKER_NAME" "$WORKER_IMAGE" smtp://127.0.0.1:1

# in_release <container> <node script> [env names…] : runs a script inside a release container.
node_probe() { docker exec "$1" node -e "$2" >/dev/null 2>&1; }
API_READY_JS="fetch('http://127.0.0.1:3000/api/v1/readyz').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"
WORKER_READY_JS="fetch('http://127.0.0.1:'+process.env.WORKER_METRICS_PORT+'/healthz').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"
ready=0
for _ in $(seq 1 60); do
  if node_probe "$API_NAME" "$API_READY_JS" && node_probe "$WORKER_NAME" "$WORKER_READY_JS"; then ready=1; break; fi
  sleep 2
done
if [ "$ready" != 1 ]; then
  { echo "the saved release did not become ready against the restore"
    docker logs --tail 5 "$API_NAME" 2>&1 | tail -n 5
    docker logs --tail 5 "$WORKER_NAME" 2>&1 | tail -n 5; } >>"$ERRLOG"
  false
fi

SMOKE_LOGIN=fail; SMOKE_READ=fail; SMOKE_RANK=fail; SMOKE_OUTBOX=fail

# login: the real sign-in flow; the code mail goes to a sink inside the container.
read -r -d '' LOGIN_JS <<'JS' || true
const net = require('node:net');
const base = 'http://127.0.0.1:3000/api/v1';
const email = process.env.SMOKE_EMAIL;
let mail = '';
const sink = net.createServer((socket) => {
  let buf = '';
  let inData = false;
  socket.write('220 sink ESMTP\r\n');
  socket.on('data', (chunk) => {
    buf += chunk.toString('latin1');
    for (;;) {
      if (inData) {
        const end = buf.indexOf('\r\n.\r\n');
        if (end < 0) return;
        mail += buf.slice(0, end);
        buf = buf.slice(end + 5);
        inData = false;
        socket.write('250 queued\r\n');
        continue;
      }
      const eol = buf.indexOf('\r\n');
      if (eol < 0) return;
      const line = buf.slice(0, eol).toUpperCase();
      buf = buf.slice(eol + 2);
      if (line.startsWith('DATA')) { inData = true; socket.write('354 go\r\n'); }
      else if (line.startsWith('QUIT')) { socket.write('221 bye\r\n'); socket.end(); return; }
      else socket.write('250 ok\r\n');
    }
  });
  socket.on('error', () => {});
});
const call = async (method, path, body, cookie) => {
  const headers = { 'x-bantoozi-client': 'web' };
  if (method !== 'GET') headers['idempotency-key'] = crypto.randomUUID();
  if (body) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  return { res, json: await res.json().catch(() => null) };
};
sink.listen(1025, '127.0.0.1', async () => {
  try {
    const requested = await call('POST', '/auth/request-code', { email });
    if (requested.res.status !== 202) throw new Error('request-code ' + requested.res.status);
    let code = null;
    for (let i = 0; i < 40 && code === null; i += 1) {
      const body = mail.split('\r\n\r\n').slice(1).join('\r\n\r\n');
      code = /\b(\d{6})\b/.exec(body)?.[1] ?? null;
      if (code === null) await new Promise((r) => setTimeout(r, 500));
    }
    if (code === null) throw new Error('no code mail');
    const verified = await call('POST', '/auth/verify', { email, code });
    if (verified.res.status !== 200) throw new Error('verify ' + verified.res.status);
    const cookies = verified.res.headers.getSetCookie().map((c) => c.split(';')[0]);
    if (cookies.length === 0) throw new Error('no session cookie');
    console.log('USER=' + verified.json.user.id);
    console.log('COOKIE=' + cookies.join('; '));
    process.exit(0);
  } catch (error) {
    console.error(String(error && error.message));
    process.exit(1);
  }
});
JS
LOGIN_OUT="$(SMOKE_EMAIL="$SMOKE_EMAIL" docker exec -e SMOKE_EMAIL "$API_NAME" node -e "$LOGIN_JS" 2>>"$ERRLOG")" && {
  SMOKE_USER="$(printf '%s\n' "$LOGIN_OUT" | sed -n 's/^USER=//p' | head -n 1)"
  SMOKE_COOKIE="$(printf '%s\n' "$LOGIN_OUT" | sed -n 's/^COOKIE=//p' | head -n 1)"
  if [[ "$SMOKE_USER" =~ ^[0-9a-f-]{36}$ ]] && [ -n "$SMOKE_COOKIE" ]; then SMOKE_LOGIN=ok; fi
}

# outbox and rank: an intent for the smoke user's ranking is written into the restored outbox; the
# release worker's relay must deliver it (outbox) and its queue must run the handler (rank).
psql_throwaway() { docker exec -i "$PG_NAME" psql -U postgres -d bantoozi -X -tAq -v ON_ERROR_STOP=1 "$@" 2>>"$ERRLOG"; }
if [ "$SMOKE_LOGIN" = ok ]; then
  INTENT="$(psql_throwaway -c "insert into job_outbox (queue, payload, dedupe_key) values ('user.rank', jsonb_build_object('userId', '$SMOKE_USER', 'reason', 'release_smoke', 'full', true), 'release-smoke') returning id" | head -n 1)"
  if [[ "$INTENT" =~ ^[0-9]+$ ]]; then
    for _ in $(seq 1 45); do
      [ "$(psql_throwaway -c "select delivered_at is not null from job_outbox where id = $INTENT")" = t ] && { SMOKE_OUTBOX=ok; break; }
      sleep 2
    done
    for _ in $(seq 1 45); do
      [ "$(psql_throwaway -c "select count(*) from pgboss.job where name = 'user.rank' and data ->> 'userId' = '$SMOKE_USER' and data ->> 'reason' = 'release_smoke' and state = 'completed'")" = 1 ] && { SMOKE_RANK=ok; break; }
      sleep 2
    done
  fi
fi

# read: the reader surface answers for the signed-in user after the ranking pass.
read -r -d '' READ_JS <<'JS' || true
const base = 'http://127.0.0.1:3000/api/v1';
const get = async (path) => {
  const res = await fetch(base + path, { headers: { 'x-bantoozi-client': 'web', cookie: process.env.SMOKE_COOKIE }, signal: AbortSignal.timeout(20000) });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const [me, list, counts] = await Promise.all([get('/me'), get('/articles?lane=for_you&limit=5'), get('/articles/counts')]);
const ok = me.status === 200 && list.status === 200 && Array.isArray(list.json?.items) && counts.status === 200;
if (!ok) console.error('me ' + me.status + ' list ' + list.status + ' counts ' + counts.status);
process.exit(ok ? 0 : 1);
JS
if [ "$SMOKE_LOGIN" = ok ]; then
  if SMOKE_COOKIE="$SMOKE_COOKIE" docker exec -e SMOKE_COOKIE "$API_NAME" node --input-type=module -e "$READ_JS" >/dev/null 2>>"$ERRLOG"; then SMOKE_READ=ok; fi
fi

RELEASE_LINE="RELEASE_SMOKE login=$SMOKE_LOGIN read=$SMOKE_READ rank=$SMOKE_RANK outbox=$SMOKE_OUTBOX"
if [ "$RELEASE_LINE" != "RELEASE_SMOKE login=ok read=ok rank=ok outbox=ok" ]; then
  echo "$RELEASE_LINE" >>"$ERRLOG"
  false
fi
docker rm -f -v "$WORKER_NAME" "$API_NAME" >/dev/null 2>&1 || true
WORKER_NAME=""; API_NAME=""

STAGE=mark
DURATION=$(( $(date -u +%s) - START_EPOCH ))
printf '{"ok":true,"restoredAt":"%s","durationS":%s,"backupAgeS":%s}' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$DURATION" "$BACKUP_AGE_S" |
  reader tools_run backup:put-raw "${P}restore-tested.json" >/dev/null

STAGE=event
printf '%s\n' "$VERIFY_OUT"
printf '%s\n' "$REPLAY_OUT"
printf '%s\n' "$RECOVERY_OUT"
printf '%s\n' "$ROLES_OUT"
echo "ROLE_LOGINS tcp_scram=$ROLE_LOGINS"
echo "RELEASE_IMAGES source=$RELEASE_SOURCE"
echo "$RELEASE_LINE"
echo "BACKUP_ID=$ID"
echo "RESTORE_DURATION_S=$DURATION"
echo "BACKUP_AGE_S=$BACKUP_AGE_S"
if ! post_event_retry restore_ok "restore of $ID ok duration_s=$DURATION backup_age_s=$BACKUP_AGE_S $(printf '%s' "$REPLAY_OUT" | cut -c1-200)"; then
  echo "restore-test: the restore is verified but restore_ok could not be recorded after retries: $(err_tail)" >&2
  exit 1
fi
STAGE=done
