# Bantoozi operations runbook

Single self-hosted box, Docker Compose project `bantoozi-prod` (spec 11). Steps that need the owner
(a person with the registrar, the mail provider, the production secrets or the offline keys) are marked
**owner**. Every value in angle brackets or in `UPPER_CASE` is a placeholder: no secret appears in this file.

Conventions used in every command below:

```bash
# On the host, as the deploy user. Adjust the two paths once; everything below reuses them.
export BANTOOZI_ROOT=/srv/bantoozi                 # the git checkout (placeholder)
export BANTOOZI_ENV=/etc/bantoozi/prod.env         # host secrets file, mode 600, outside the repo
export COMPOSE_PROJECT_NAME=bantoozi-prod
dc() { docker compose -f "$BANTOOZI_ROOT/infra/compose.yml" --env-file "$BANTOOZI_ENV" "$@"; }
```

Never print the env file or `dc config` (it interpolates secrets). Admin API calls need a session of an
admin account, `X-Bantoozi-Client: web` on every non-GET request and an `Idempotency-Key: <UUID>`
(spec 08 §1); almost everything below can also be done in the admin UI under `/admin`, which is the
preferred route. The API examples show the exact endpoint for the cases where a script is wanted.

Contents: 1 first install, 2 deploy, 3 rollback, 4 backups and restore, 5 breaker reset, 6 budget raise,
7 invites and waitlist, 8 model upgrade, 9 G1 settings, 10 provider credentials, 11 alerts, 12 SMTP,
13 starter-bundle check, 14 host reboot, 15 contacts and maintenance mode, then the launch checklist.

---

## 1. First install and host bootstrap

**When:** once, on a new host. **Undo:** wipe the host; nothing else holds state until the first backup.

Preconditions (**owner**): the host of spec 11 §1 (8 vCPU, 16-32 GB RAM, 160 GB NVMe, Ubuntu LTS); a DNS
`A`/`AAAA` record for `PUBLIC_HOST` pointing at it; SMTP credentials (section 12); an S3-compatible backup
bucket and the `age` recipient/identity (section 4); provider keys (section 10).

1. Host packages and firewall:

   ```bash
   sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 unattended-upgrades fail2ban rclone age ufw git
   sudo systemctl enable --now docker chrony   # docker restarts the stack after a reboot (section 14)
   sudo ufw default deny incoming && sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw enable
   ```

   Docker-published ports bypass ufw: the stack publishes only Caddy's 80/443 (`infra/compose.yml`). Verify
   from a different machine: `nmap -Pn -p 1-10000 <host>` shows only 22, 80, 443.
   SSH is key-only (`PasswordAuthentication no` in `/etc/ssh/sshd_config`). `timedatectl` must report the
   clock as synchronized. **owner**: DNS, host access.

2. Check out the approved release tag (production deploys refuse anything else) and create the env file:

   ```bash
   sudo git clone <REPO_URL> "$BANTOOZI_ROOT" && cd "$BANTOOZI_ROOT" && git checkout <vYYYY.MM.DD-N>
   sudo install -d -m 700 /etc/bantoozi
   sudo install -m 600 "$BANTOOZI_ROOT/infra/env/prod.example.env" "$BANTOOZI_ENV"
   ```

   Edit `$BANTOOZI_ENV` and replace **every** placeholder (`deploy.sh` refuses values containing
   `change-me` or `example.com`). Generate secrets locally, for example `openssl rand -hex 24` (letters and
   digits only for database passwords; no `$` or quote characters anywhere):

   | Variable | Value |
   |---|---|
   | `PUBLIC_HOST`, `PUBLIC_BASE_URL`, `ACME_EMAIL` | the real domain, `https://<domain>`, a monitored address (**owner**) |
   | `POSTGRES_PASSWORD`, `BANTOOZI_OWNER_PASSWORD`, `BANTOOZI_APP_PASSWORD`, `BANTOOZI_WORKER_PASSWORD` | four **distinct** generated passwords |
   | `SESSION_PEPPER`, `METRICS_TOKEN` | generated, at least 32 characters |
   | `ADMIN_EMAILS` | comma list: the admin account(s); also the alert recipients (**owner**) |
   | `MAIL_TRANSPORT=smtp`, `SMTP_URL`, `MAIL_FROM` | from the mail provider (**owner**, section 12) |
   | `TYPESAFE_MODEL` | the pinned model, for example the value G1 was measured with (section 8) |
   | `PROVIDER_MASTER_KEY_ID`, `PROVIDER_MASTER_KEYS` | the keyring: id of the active key and a JSON map of id to base64 32-byte key; back up offline (**owner**) |
   | `DAILY_BUDGET_USD` | initial value; the live value is the admin setting (section 6, 9) |
   | `COMPOSE_PROFILES` | `translate` if any language mode is `translate` or `card_text_mode` is `english`; `laya` only with `engine.laya` |
   | `DELETION_LEDGER_PATH`, `DELETION_LEDGER_RECIPIENT`, `DELETION_HMAC_KEY` | see section 4.4; the ledger is mandatory for account purges |

   Keep a copy of the finished env file, encrypted, with the offline keys (**owner**; spec 11 §4).

3. First deploy: section 2 (`deploy.sh` runs migrate, then seed, then starts the services).
4. Admin account: sign in at `https://<PUBLIC_HOST>/login` with an address listed in `ADMIN_EMAILS`
   (no invite needed); the login code arrives by e-mail. Create the first invites (section 7).
5. Stage the provider key (section 10), apply the G1 settings (section 9), then run the launch checklist at
   the end of this file.
6. Cron (host crontab of the deploy user, `CRON_TZ=UTC` explicit): see section 4.1.

**Verify:** `curl -fsS https://<PUBLIC_HOST>/api/v1/readyz` answers 200; `dc ps` shows `api`, `worker`,
`caddy`, `postgres` healthy; the header check of spec 11 §7:
`curl -sI https://<PUBLIC_HOST>/login | grep -iE 'strict-transport|content-security|nosniff|referrer-policy|permissions-policy'`.

---

## 2. Deploy

**When:** every release. **Preconditions:** the release tag `vYYYY.MM.DD-N` exists and CI is green; the host
checkout is clean and **at that tag** (`git fetch --tags && git checkout <tag>`); at least 10 GB free disk
(`DEPLOY_MIN_FREE_GB`); the backup bucket is reachable (a production deploy refuses to run without the
pre-deploy backup, except on a fresh instance with no database yet, where it says so and skips it). If
maintenance mode is on from an earlier failed deploy, the deploy runs behind it and leaves it on (section 15).
Expect a short maintenance window: no zero-downtime promise (spec 11 §3).

```bash
cd "$BANTOOZI_ROOT" && git fetch --tags && git checkout <vYYYY.MM.DD-N>
infra/scripts/deploy.sh --env-file "$BANTOOZI_ENV" <vYYYY.MM.DD-N>
```

What `deploy.sh` does, in this order (`infra/scripts/deploy.sh`): lock and clean-checkout check; environment
validation (required variables, placeholders, distinct passwords, profiles, connection budget, free disk);
**profile gates**, before anything is replaced: with the stored settings read from the database, it fails naming
the check when `language_modes` holds `translate` or `card_text_mode` is `english` (or the env `LANGUAGE_MODES` /
`CARD_TEXT_MODE` ask for it) without the `translate` profile, or when `engine.laya` lists a language or Laya work
is outstanding (undelivered `*.laya` outbox rows, queued `*.laya` jobs) without the `laya` profile; records the
previous image ids (tags them `<image>:previous`) and the schema version; **pre-deploy backup**
(`backup.sh --pre-deploy --env-file`, must succeed; skipped with the reason "fresh instance" when the Postgres
volume or database does not exist yet); build of immutable images with the frozen lockfile; Postgres healthy;
**migrate, then seed on every deploy** (`migrate` job = `pnpm db:migrate`, then `seed` job = `pnpm db:seed`,
both must exit 0, otherwise the application containers are not replaced); old worker/api stopped and drained,
new `api`/`worker` (and `worker-laya`, `libretranslate` per profile) started, then `caddy`; **smoke** for up
to 120 s (`DEPLOY_SMOKE_TIMEOUT`): `/api/v1/readyz` 200, login page 200, one static asset 200, worker heartbeat
healthy, **outbox dispatch** (the smoke writes a `house.purge-auth` intent into `job_outbox`; the relay must
deliver it: `smoke: outbox dispatch ok`) and a **queue traversal** (the pg-boss job must complete; in a rehearsal
an expired fixture row in `rate_limit_buckets` must also be purged by the handler: `smoke: queue traversal ok`).
On success it prints `deploy: OK; log <file>` plus the image ids and the schema version before/after;
the log is in `~/.local/state/bantoozi/deploy/` (`DEPLOY_STATE_DIR`).

Seeding is idempotent and never overwrites admin settings or switches an active question set. The seed also
creates the `engine.model_pin` row. A deploy never needs a manual `pnpm db:seed`; run it by hand only to repair a
failed seed job: `dc up --no-build --no-deps --exit-code-from seed seed`.

After a deploy, also check the admin overview (`/admin`): no backlog alert, worker heartbeat fresh.

**If the smoke fails** the script restores the previous application images itself and exits non-zero (and says
whether schema changes were kept). It then waits for the restored `api` and `worker` to report healthy against
the expanded schema. If they do, it says "compatibility demonstrated". If they do not (or there are no previous
images, as on a first deploy), compatibility is not demonstrated: it **switches maintenance mode on** (section 15)
and says so in the log, and the site answers 503 until you fix the cause and run `infra/scripts/maintenance.sh
--env-file "$BANTOOZI_ENV" off`. Read the deploy log and `dc logs --tail 100 api worker`. Do not reverse
migrations (section 3).

**Local rehearsal** (a developer machine, no production host, no internet):

```bash
cp infra/env/local-rehearsal.env.example /tmp/rehearsal.env     # public throwaway values, project bantoozi-prod-rehearsal
infra/scripts/deploy.sh --local-rehearsal --env-file /tmp/rehearsal.env HEAD
```

Rehearsal skips the release-tag requirement, adds the `rehearsal` profile (mail catcher `mailpit` and the S3
stand-in `minio`, no published ports) and serves `https://localhost:18444` with Caddy's internal CA. It still
takes the pre-deploy backup when `BACKUP_S3_*` and `BACKUP_AGE_RECIPIENT` are set in the env file (creating the
bucket on the stand-in); without them it skips the backup and logs the reason "rehearsal". The first deploy of a
rehearsal has no database: "fresh instance".
Tear down: `docker compose -f infra/compose.yml --env-file /tmp/rehearsal.env --profile rehearsal down -v`
(with `COMPOSE_PROJECT_NAME=bantoozi-prod-rehearsal` exported). Never run it against production data.

**Undo:** section 3.

---

## 3. Rollback

**When:** a release misbehaves after a successful smoke, or the smoke itself failed and the automatic restore
did not run or did not help. **Rule (spec 11 §3 step 6):** roll back **application images only**. Migrations are
expand/contract and backward compatible with the previous release; never reverse a migration and never restore
the database over writes made after the deploy.

**Primary path: deploy the previous release tag.** `deploy.sh` has no `rollback` subcommand; a rollback is a deploy
of the previous release over the already expanded schema (migrate and seed are no-ops there; the previous code
must tolerate the expanded schema, which is the expand/contract rule):

```bash
cd "$BANTOOZI_ROOT" && git checkout <previous vYYYY.MM.DD-N>
infra/scripts/deploy.sh --env-file "$BANTOOZI_ENV" <previous vYYYY.MM.DD-N>
```

It takes a pre-deploy backup, runs the same gates and smoke (readyz, login page, asset, worker heartbeat,
outbox dispatch, queue traversal) and keeps reader state, sessions and the schema. If that smoke fails too, it
turns maintenance mode on (section 15).

**Fast path: image retag**, when the previous images are still on the host and a rebuild is not wanted. The
images the script leaves behind are the mechanism:
`<image>:previous` (the images running before the last deploy) and `<image>:<commit12>` (each deployed
commit). Image names are `<project>-<service>`, here `bantoozi-prod-api`, `bantoozi-prod-worker`,
`bantoozi-prod-caddy` (and `bantoozi-prod-worker-laya` with the `laya` profile).

```bash
# 1. Confirm what is available.
docker images --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.CreatedAt}}' | grep '^bantoozi-prod-'
# 2. Point the running tag at the previous images and recreate the application containers only.
for s in api worker caddy; do docker tag "bantoozi-prod-$s:previous" "bantoozi-prod-$s:latest"; done
dc up -d --no-deps --no-build --force-recreate worker api caddy
# 3. Verify.
curl -fsS https://<PUBLIC_HOST>/api/v1/readyz && dc ps
```

Do not run `deploy.sh` or `dc build` between steps 2 and 3: a rebuild moves `:latest` forward again. To go back
to a release older than `:previous`, use its `:<commit12>` tag instead of `:previous`, or use the primary path
with that release tag.

**When a migration blocks rollback** (the new release dropped or changed something the previous release needs,
the previous images crash on the current schema, or `readyz` stays failing after the image swap): do not edit
the schema by hand and do not restore a backup over live writes. Put the site in maintenance mode (section 15),
fix forward with a patch release (deploy it as in section 2), and only if the data itself is damaged go to the
recovery runbook (section 4.4). Record the incident.

**Verify:** section 2 smoke list, plus one login and one article open as a tester. **Undo:** repeat with the
newer tag (`dc up … --force-recreate` after tagging `bantoozi-prod-<svc>:<commit12>` as `:latest`).

---

## 4. Backups and restore

Scripts: `infra/scripts/backup.sh` and `infra/scripts/restore-test.sh` (flags below are the real ones; `--help`
prints the usage). Targets: RPO <= 24 h, RTO <= 4 h, accepted by the **owner**; a daily dump does not give
point-in-time recovery.

### 4.1 Backup (host cron 02:30 UTC)

What it does: under a host lock, `pg_dump -U postgres -Fc bantoozi` plus `pg_dumpall --globals-only
--no-role-passwords`, streamed through `age` (no plaintext dump on disk), a manifest (UTC times, commit and
image digests, schema version, backup id, ciphertext checksums), upload to the S3-compatible bucket
(`<BACKUP_S3_PREFIX><YYYYMMDDTHHMMSSZ>/...`), size/checksum verification, then `POST /api/v1/admin/ops-event`
with `backup_ok` (or `backup_failed`). The deletion ledger is uploaded as a separate object by every run.
Retention: 7 daily, 4 weekly (Sunday), 6 monthly (1st); a restore-tested backup is never pruned.

Environment (separate mode-600 file, **owner** supplies the values): `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`,
`BACKUP_S3_PREFIX`, `BACKUP_S3_ACCESS_KEY`/`BACKUP_S3_SECRET_KEY` (writer), `BACKUP_S3_PRUNE_ACCESS_KEY`/
`BACKUP_S3_PRUNE_SECRET_KEY` (retention-delete), `BACKUP_AGE_RECIPIENT` (public key only),
`DELETION_LEDGER_PATH`, `DELETION_LEDGER_RECIPIENT`. The backup host file never contains the age identity.

Host crontab (deploy user):

```cron
CRON_TZ=UTC
30 2 * * *  <BANTOOZI_ROOT>/infra/scripts/backup.sh --env-file /etc/bantoozi/backup.env
0 4 * * 0   <BANTOOZI_ROOT>/infra/scripts/restore-test.sh --env-file /etc/bantoozi/restore.env --identity <PATH_TO_AGE_IDENTITY>
*/15 * * * * <BANTOOZI_ROOT>/infra/scripts/host-health.sh --env-file <BANTOOZI_ENV> >>/var/log/bantoozi-host-health.log 2>&1
```

The last line is the host disk report (section 11).

Flags: `backup.sh --env-file <file> [--pre-deploy | --prune-only [--now <iso>]]` (`--env-file` or the variable
`BANTOOZI_ENV_FILE`; `--pre-deploy` labels the backup `deploy.sh` takes, which passes the deploy env file
itself; `--prune-only` applies the retention policy and `--now` overrides the clock for tests). Exit 75 means
another backup of the project holds the lock. Manual run: `infra/scripts/backup.sh --env-file
/etc/bantoozi/backup.env`. The tools image `bantoozi-backup-tools:local` is built from the checkout on first use.

Verify: exit 0, a `backup_ok` ops event (admin overview), the new id listed in the bucket, size matches. A
missing `backup_ok` for 26 h raises the "No recent backup" alert (section 11). **Undo:** a bad backup is simply
not advertised (no `backup_ok`); delete the partial prefix with the prune credentials.

### 4.2 Weekly restore test (Sunday 04:00 UTC)

`restore-test.sh --env-file <restore.env> --identity <age identity> [--backup-id <YYYYMMDDTHHMMSSZ>]` (default:
the newest valid backup; `--env-file` or `BANTOOZI_ENV_FILE`; exit 75 when another restore test holds the lock).
It restores into a throwaway Postgres 16 with no network and no published ports, verifies schemas,
migration count, FK/sequence/RLS with two tenants, the cold bookmark snapshot checksum, provider credential
decryption against a fake provider and the deletion-ledger replay, runs `recovery:prepare` (section 4.4), and
then starts the **saved release** (the `api` and `worker` image ids recorded in the manifest; the current images
when the host no longer has them, said in `RELEASE_IMAGES source=current`) against the restore with no network
at all (`--network none`, the database through its unix socket, a mail sink inside the api container, no
provider key) and signs in, reads, ranks and relays an outbox intent. It prints machine-readable lines
(`RESTORE_DURATION_S=`, `BACKUP_AGE_S=`, `SCHEMA_VERSION=`, `REPLAY entries=...`, `RECOVERY_PREPARE ...`,
`RELEASE_SMOKE login=ok read=ok rank=ok outbox=ok`), removes the throwaway containers and database on every exit
and posts `restore_ok` / `restore_failed`. A smoke step that is not `ok` fails the test. `restore.env` is the
backup env plus the separately kept recovery material (`PROVIDER_MASTER_KEY_ID`, `PROVIDER_MASTER_KEYS`,
`DELETION_HMAC_KEY`). The age identity lives off the host and is mounted only for the test (**owner**).

Record the printed duration and backup age in the launch checklist (measured RTO/RPO). A failed test raises
"Restore test failed".

### 4.3 Keys that must exist outside this host (**owner**)

The age identity (recovery key), the provider master-key ring, `DELETION_HMAC_KEY`, the deletion-ledger
recipient identity, the encrypted copy of the env file. A backup without them is not recoverable. Test
restoring from the offline copies at least once before launch.

### 4.4 Actual recovery (spec 11 §4.1)

**When:** database loss or corruption confirmed by a human. Never as an automatic reaction to a transient
application error. **Preconditions:** the offline keys of 4.3, a host or fresh volume, the env file.

1. Maintenance mode (section 15); stop `worker`, `worker-laya` and `api`; deny provider/mail egress (do not
   start the stack with real `SMTP_URL`/provider keys until step 6: use a recovery env file with
   `MAIL_TRANSPORT` pointing at a sink).
2. Select the newest verified backup id in the bucket. Decrypt with the offline identity, restore globals and
   roles, then the database into a **new** volume (same steps as `restore-test.sh`, which is the tested path
   and is the preferred way to produce and verify the restored database). Run the weekly-test verification on it.
3. **Replay the deletion ledger before any user data is served:** decrypt the ledger entries
   (`DELETION_LEDGER_PATH` object, one base64 age line per entry, dedupe by entry id), recompute
   `emailHmac` with `DELETION_HMAC_KEY` and delete again every matching user, `waitlist` row, unused invite and
   the email on consumed invites. The commands are `ledger:replay` (and `restore:verify`) of the
   `bantoozi-backup-tools:local` image, as `restore-test.sh` runs them (it prints `REPLAY entries=... users=...
   waitlist=... invites=...`). Revoke all restored sessions and login codes (the replay does).
4. Queue recovery: do not resume restored `pgboss` jobs. Run `recovery:prepare` on the restored database
   **before any worker starts**: it cancels every pg-boss job still `active` (their workers are gone), resets
   outbox relay leases and origin fetch leases, returns `running` analysis requests to `pending` with the lease
   cleared, keeps queued jobs and undelivered outbox intents, and prints
   `RECOVERY_PREPARE active_jobs_cancelled=N outbox_leases_cleared=N origin_leases_cleared=N analysis_leases_reset=N outbox_pending=N`.
   It does not touch spend reservations: keep paid inference paused until the day's totals are reconciled
   (step 5). Idempotent. With the restored database in a postgres container, as `restore-test.sh` does:

   ```bash
   docker run --rm --network container:<RESTORED_POSTGRES_CONTAINER> --user "$(id -u):$(id -g)" \
     --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
     bantoozi-backup-tools:local recovery:prepare
   ```

   (`RESTORE_DATABASE_URL`, default `postgres://postgres@127.0.0.1:5432/bantoozi`, selects another database
   via `-e RESTORE_DATABASE_URL`.) Then run reconciliation (`house.reconcile` does this after the worker
   starts), skipping deleted users and superseded work; disable delivery of old authentication/operational
   e-mails.
5. Spend: remote provider usage after the backup still happened. Keep paid inference paused (set
   `engine.daily_budget_usd` to `0` through section 6) until the day's spent/reserved totals are reconciled or the
   UTC day rolls over.
6. Start `worker`, then `api` and `caddy` (`dc up -d --no-build worker api caddy`), verify read/write/queue and
   a fresh backup, leave maintenance mode, record the real loss window and recovery duration in the incident
   record.

Warning for **owner**: the worker container has a read-only root filesystem and only a tmpfs `/tmp`. The compose
file mounts a `ledger` volume at `/var/lib/bantoozi/ledger` and the env examples point `DELETION_LEDGER_PATH`
at `deletion-ledger.age` there; keep it that way, since a path outside a mounted volume is lost on restart and
`backup.sh` ships exactly this file. Test the ledger path before launch.

---

## 5. Breaker reset

**When:** the "Engine breaker open" alert, or the decision engine breaker (`settings['engine.circuit']`) stays
`open` or `auth` after the cause is fixed (provider outage ended, key replaced). **Preconditions:** the
provider answers (check the provider status page) and, for `auth`, a valid key is active (section 10). A reset
only requests a probe: the worker closes the breaker after a successful call.

Admin UI: `/admin` overview page, reset button for the engine. API:

```bash
# engine is "typesafe" or "llm"; needs an admin session cookie in $COOKIE_JAR
curl -sS -b "$COOKIE_JAR" -X POST https://<PUBLIC_HOST>/api/v1/admin/engine/reset-breaker \
  -H 'Content-Type: application/json' -H 'X-Bantoozi-Client: web' -H "Idempotency-Key: $(uuidgen)" \
  -d '{"engine":"typesafe"}'          # -> 200 {"engine":"typesafe","resetRequestedAt":"<iso>"}
```

(`apps/api/src/routes/admin/engine.ts`, `ResetBreakerBodySchema`.) **Verify:** `GET /api/v1/admin/overview`
(or the overview page) shows the breaker closed within a few minutes and the recovery notification arrives.
If it re-opens at once the provider is still failing: do not repeat the reset in a loop. **Undo:** none needed;
the breaker reopens by itself on failures.

---

## 6. Budget raise

**When:** "Daily budget at 80 %" / "exhausted" alert and the owner decides to spend more (**owner**). The
initial value is `DAILY_BUDGET_USD` in the env file; the live value is the admin setting
`engine.daily_budget_usd`, which wins. Do not raise it above what the provider account allows.

Admin UI: `/admin/settings`. API:

```bash
curl -sS -b "$COOKIE_JAR" -X PATCH https://<PUBLIC_HOST>/api/v1/admin/settings \
  -H 'Content-Type: application/json' -H 'X-Bantoozi-Client: web' -H "Idempotency-Key: $(uuidgen)" \
  -d '{"engine.daily_budget_usd": 2.0}'     # -> 200 {values, stored, rankerSettingsVersion, changed: [...]}
```

(`apps/api/src/routes/admin/settings.ts`; patchable keys: `engine.daily_budget_usd`, `engine.llm_daily_cap`,
`engine.prefilter_enabled`, `engine.laya`, `language_modes`, `card_text_mode`, `ranker.thresholds`,
`translate.tier2_daily_cap`, `question_sets.active`, `signup_mode`.) The G1 recommendation is
USD 1.00/day (section 9). **Verify:** `GET /api/v1/admin/settings` shows the new value and `GET
/api/v1/admin/usage` shows spend against it. **Undo:** PATCH the old value. A budget cut to `0` pauses paid
inference; ingestion, reading and bookmark capture continue.

---

## 7. Invite batch and waitlist

**When:** onboarding testers (10 invites before launch, then in batches). Signup is invite-only
(`SIGNUP_MODE=invite`, setting `signup_mode`). Admin accounts need no invite.

Admin UI: `/admin/invites` and `/admin/waitlist`. API:

```bash
# 10 unbound codes (count 1..50, expiresDays 1..90 optional); the response lists the codes: hand them out privately
curl -sS -b "$COOKIE_JAR" -X POST https://<PUBLIC_HOST>/api/v1/admin/invites \
  -H 'Content-Type: application/json' -H 'X-Bantoozi-Client: web' -H "Idempotency-Key: $(uuidgen)" \
  -d '{"count":10,"note":"beta testers","expiresDays":30}'            # -> 201 {items:[{code,...}]}
# one invite bound to an address and e-mailed (count must be 1)
curl -sS -b "$COOKIE_JAR" -X POST https://<PUBLIC_HOST>/api/v1/admin/invites ... -d '{"count":1,"email":"<TESTER_EMAIL>"}'
# list existing invites / the waitlist
curl -sS -b "$COOKIE_JAR" 'https://<PUBLIC_HOST>/api/v1/admin/invites'
curl -sS -b "$COOKIE_JAR" 'https://<PUBLIC_HOST>/api/v1/admin/waitlist'
# invite a waitlist entry (creates a bound invite and e-mails it)
curl -sS -b "$COOKIE_JAR" -X POST https://<PUBLIC_HOST>/api/v1/admin/waitlist/<ID>/invite \
  -H 'X-Bantoozi-Client: web' -H "Idempotency-Key: $(uuidgen)"
```

(`apps/api/src/routes/admin/accounts.ts`.) The public waitlist form posts to `POST /api/v1/waitlist` (5 per
hour per IP). **Verify:** an invite code redeems at `/join`; the waitlist form on the login page shows a
confirmation and the row appears in `/admin/waitlist`. Unused invites expire and are purged 30 days after
expiry. **Undo:** delete is not offered; let unused codes expire or set `signup_mode` back if the batch was a
mistake.

---

## 8. Model or question-set upgrade (spec 11 §8)

**When:** a new `TYPESAFE_MODEL`, enrich question set, Laya checkpoint or calibration, or new Ollama fallback
models. **Preconditions:** the golden database and rating data on the owner's machine (**owner**); budget
headroom (section 6).

1. Replay on the golden set against the stored reference run (run on the owner's machine with the eval
   environment; exit 0 = pass, 4 = fail, 5 = inconclusive; a failed or inconclusive replay blocks the upgrade):

   ```bash
   pnpm evaluate replay <RUN_ID> --model <NEW_TYPESAFE_MODEL> [--question-set <enrich-vN>] [--max-usd <N>] [--out <report.md>]
   # LLM fallback models instead:  pnpm evaluate replay <RUN_ID> --engine llm --llm-model <MODEL>
   ```

   (`apps/eval/src/commands/replay.ts`; the report goes to `apps/eval/reports/` by default. Commit the report.)

2. Set the new value in `$BANTOOZI_ENV` (`TYPESAFE_MODEL=...`; fallback models `OLLAMA_MODEL_FAST/STRONG`;
   a new enrich question set is an admin setting `question_sets.active`) and restart:
   `dc up -d --no-deps --force-recreate worker api` (the compose file passes `TYPESAFE_MODEL` to both).
3. The first worker that starts with a new model records it in `settings['engine.model_pin']` under a row
   lock and enqueues `house.reenrich` and `house.rematch` once, rebuilding the `RANK_WINDOW_DAYS` window
   within budget (translations are reused). Watch `/admin` (backlog, spend) until the queues drain; the
   rebuild never opts users in or enables untrained feeds.
4. Check that feature meanings are still compatible. If `feature_spec_sha` changed, incompatible user models
   are deactivated and users fall back to cards scoring until retrained.

**Verify:** new answers carry the new model id; no backlog alert; spend within budget. **Undo:** restore the
old env value, recreate `worker api`; the pin change enqueues a rebuild again.

---

## 9. Applying the G1 settings in production (**owner**)

The G1 decision: `apps/eval/reports/G1-2026-10-08-decision.md` and `apps/eval/config/g1.json` (profile
`owner_pilot`, PASS on `golden-v3`, test macro AUC 0.709 against 0.70). It is one-person, assisted evidence
(see `notes` in the file). Initial-beta eligibility is owner-approved (D-147, D-148 in `docs/DECISIONS.md`).

`eval apply-g1` (`pnpm evaluate apply-g1 apps/eval/config/g1.json --report
apps/eval/reports/G1-2026-10-08-decision.md`) writes the G1 keys in one transaction but **only to a database
that contains the golden dataset, the runs and the gate lock** (`checkG1` refuses otherwise). It was applied to
the golden database. The production database has no `eval` data, so apply the same values to production through
the admin settings (the same keys, same validation, same side-effect intents):

```bash
curl -sS -b "$COOKIE_JAR" -X PATCH https://<PUBLIC_HOST>/api/v1/admin/settings \
  -H 'Content-Type: application/json' -H 'X-Bantoozi-Client: web' -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "language_modes": {"en":"native","cs":"native","sk":"native"},
    "card_text_mode": "as_written",
    "ranker.thresholds": {"lanes":{"forYou":0.65,"maybe":0.35},"tiers":[0.25,0.45,0.65,0.85],
      "demotion":{"clickbait":0.8,"promotional":0.8,"shallowDepth":0.45,"staleTimeSensitive":0.75}},
    "engine.daily_budget_usd": 1,
    "translate.tier2_daily_cap": 300
  }'
```

Re-read `apps/eval/config/g1.json` before sending and copy its values exactly; the block above mirrors it as of
this writing. `laya_track_recommended` (SK) is informational: M9, not a launch setting. **Verify:**
`GET /api/v1/admin/settings` returns these values; `changed` lists the keys; rankings refresh for active users
(`ranker.settings_version` increments). **Undo:** PATCH the previous values (read them from the earlier
`GET /admin/settings`; keep that output before changing anything).

---

## 10. Provider credentials

Provider API keys live encrypted in `provider_credentials`; `TYPESAFE_API_KEY`/`OLLAMA_API_KEY` in the env file
are bootstrap fallbacks only. Admin UI: `/admin/providers` (stage, validate, activate, revoke). Server CLI
(`apps/worker/src/credentials/commands.ts`), run inside the worker container (the worker role, the keyring in
its environment, `dist/cli.js` is built into the image):

```bash
ADMIN=<ADMIN_EMAIL>      # an active administrator, recorded as updated_by
dc exec -T worker node dist/cli.js credentials:status
dc exec -T worker node dist/cli.js credentials:stage typesafe --admin "$ADMIN" < /path/to/key.txt   # key from stdin only, never argv
dc exec -T worker node dist/cli.js credentials:validate typesafe --admin "$ADMIN" --wait 60          # queues provider.validate; or --inline
dc exec -T worker node dist/cli.js credentials:activate typesafe --admin "$ADMIN"
dc exec -T worker node dist/cli.js credentials:revoke typesafe --admin "$ADMIN"                       # local tombstone; revoke at the provider too
dc exec -T worker node dist/cli.js credentials:rewrap                                                 # after adding a master key: rewrap under PROVIDER_MASTER_KEY_ID
```

Providers: `typesafe`, `ollama`. Options: `--expected-revision`, `--candidate-version`. (In a developer
checkout the same commands run as `pnpm worker-cli credentials:...`. The `dc exec … node dist/cli.js` form is
derived from the Dockerfile and `apps/worker/dist/cli.js`; confirm it works on the first install.) The key
is validated and encrypted locally, staged as a pending candidate, validated by a synthetic probe
(`provider.validate`), then activated (valid within 24 h, same configuration). Rotating the master key:
add the new key to `PROVIDER_MASTER_KEYS`, set `PROVIDER_MASTER_KEY_ID`, recreate `worker api`, run
`credentials:rewrap`, keep old key ids for every retained backup that needs them (**owner**).

**Verify:** `credentials:status` shows the active version and `valid`; the breaker is closed (section 5).
**Undo:** stage and activate the previous key; `revoke` clears both keys and blocks env fallback.

---

## 11. Alerts and external monitoring

`house.alerts` runs every 5 minutes, mails `ADMIN_EMAILS`, at most once per 6 h per alert until resolved, and
sends one recovery mail. Rules are in `apps/worker/src/alerts/rules.ts`. A first look is always: `dc ps`,
`dc logs --tail 100 <service>`, the `/admin` overview page.

| Alert (title) | Meaning | First response |
|---|---|---|
| Engine breaker open / Engine credentials rejected | `engine.circuit.typesafe` open > 30 min, or state `auth` (key rejected) | Check the provider status; for `auth` replace the key (section 10); then reset the breaker (section 5) |
| Daily engine budget at 80 % / exhausted | `engine.budget_alerts` crossed p80 or p100 today | Inspect `/admin/usage`; raise the budget (section 6, **owner**) or wait for 00:00 UTC |
| Backlog in `<queue>` / Stuck jobs in `<queue>` / Outbox backlog | > 5000 due jobs, oldest due job > 30 min, oldest pending outbox intent > 5 min | Is the worker up and healthy? Provider outage or spend guard? Do not restart in a loop; check `dc logs worker` |
| No worker heartbeat | newest worker heartbeat >= 30 min old (or none) | `dc ps`, `dc logs --tail 200 worker`, `dc up -d worker`; OOM kills show in `docker inspect` |
| `<job>` is overdue | a housekeeping job has not run for two periods | Worker down or the job fails; check logs; restart the worker (it enqueues overdue jobs at startup) |
| LibreTranslate unreachable | a language mode is `translate` or `card_text_mode` is `english` and the probe fails | `dc up -d libretranslate` (profile `translate`); check the `lt-models` volume |
| Many degraded articles | > 20 % of the last hour's new articles degraded (min 20 articles) | Provider trouble or breaker; see the first row |
| Many feeds failing | > 10 % of subscribed feeds errored in 24 h (min 5 feeds) | Is the host's outbound network up? Check `/admin/feeds` for the error codes |
| Disk capacity | a reported filesystem > 80 % used, < 10 GB free or no inodes | Free space (`docker system prune` only for unused images; never delete volumes); expand the disk |
| No host health report | no `host_health` ops event in the last hour | The host health script is not posting; see below |
| Backup failed / Restore test failed / No recent backup | a script reported failure via `POST /api/v1/admin/ops-event`, or no `backup_ok` for 26 h | Run the script by hand and read its output; check bucket credentials and free disk; section 4 |
| Erasure disabled (`erasure.disabled`) | users past the 7-day grace wait while the deletion ledger or `DELETION_HMAC_KEY` is not configured (a production worker refuses to start without them) | Set `DELETION_LEDGER_PATH`, `DELETION_LEDGER_RECIPIENT` and `DELETION_HMAC_KEY` (section 1), redeploy; the next 05:00 `house.purge-users` run catches up. A worker log `erasure_backup_lock_busy` instead means a backup held the erasure lock (D-189): the purge retries on the next run, no action needed unless it repeats daily |
| For You is not beating Maybe | the For You like-rate stayed below Maybe's for 3 consecutive days (>= 30 rated per lane) | A quality signal, not an outage: review the ranker thresholds and cards with the owner |

Host-side reporting: the scripts call `POST /api/v1/admin/ops-event` with `Authorization: Bearer
<METRICS_TOKEN>` (no cookie, no CSRF header) and a body `{"kind":"backup_ok"|"backup_failed"|"restore_ok"|
"restore_failed","detail":"<=2000 chars"}` or `{"kind":"host_health","detail":{...}}` (schema `HostHealthDetailSchema`
in `packages/shared/src/dto/admin.ts`, filesystems with `mount`, `usedPct`, `freeBytes`, `inodesUsedPct`). A
script that posts `host_health` is `infra/scripts/host-health.sh --env-file <BANTOOZI_ENV>`. It reports the
filesystem of the Postgres volume (`/var/lib/postgresql/data`, measured inside the postgres container) and of
the backup staging directory (`/backup-staging`, `$TMPDIR` or `/tmp` of the host): percent used, free bytes and
inode use, as one event through the api container (the token is read there, never passed as an argument).
Install it from cron every 15 minutes (the alert needs a report at least hourly):

```cron
*/15 * * * * <BANTOOZI_ROOT>/infra/scripts/host-health.sh --env-file <BANTOOZI_ENV> >>/var/log/bantoozi-host-health.log 2>&1
```

A "No host health report" alert means the cron line is missing, the postgres or api container is down, or the
script fails: run it by hand and read its output. It exits 1 when nothing could be measured or the event
could not be recorded.

**External heartbeat monitor (**owner**):** `house.alerts` cannot report a dead host or a dead worker's mail
path. Register an independent service that (a) polls `https://<PUBLIC_HOST>/api/v1/readyz` every minute and
(b) expects a ping after each successful backup (dead-man switch: the backup cron calls the monitor's check-in
URL after `backup_ok`), and sends to a person other than the host's mail path. Record the monitor, its
recipient and the escalation in section 15.

Every alert and its recovery must be shown to fire once in a drill before launch (stop the worker, make the
host unreachable); record dates in the checklist.

---

## 12. SMTP deliverability (**owner**)

Login codes are the only way in; undelivered mail is an outage. Use a real transactional provider and the
sending domain of `MAIL_FROM` (for example `no-reply@<DOMAIN>`).

1. SPF: a `TXT` record on the domain, per the provider, for example `v=spf1 include:<PROVIDER_SPF> -all`.
2. DKIM: publish the provider's `TXT`/`CNAME` selector record(s) (`<selector>._domainkey.<DOMAIN>`) and enable
   signing in the provider.
3. DMARC: `_dmarc.<DOMAIN> TXT "v=DMARC1; p=none; rua=mailto:<DMARC_REPORT_ADDRESS>"` first; move to
   `p=quarantine` after clean reports.
4. Reverse DNS and, if the provider requires, a return-path (bounce) `CNAME`.
5. `SMTP_URL=smtp://USER:PASS@<SMTP_HOST>:587` (URL-encode special characters in the password) and `MAIL_FROM`
   in the env file; apply with `dc up -d --no-deps --force-recreate api worker`.

**Verify (login mail actually delivered):** `dig +short TXT <DOMAIN>`, `dig +short TXT _dmarc.<DOMAIN>`, and
`dig +short TXT <selector>._domainkey.<DOMAIN>` return the records. Then request a login code at
`https://<PUBLIC_HOST>/login` for an address on a major mailbox provider (and a second, different provider), and
confirm it arrives in the inbox, not spam, within a minute. Open "show original" and check `spf=pass`,
`dkim=pass`, `dmarc=pass`. Record both results in the checklist. **Undo:** restore the previous `SMTP_URL`.

---

## 13. Starter-bundle live check

**When:** before launch and after any change of the bundle lists (`STARTER_BUNDLES`, `packages/shared`). It
fetches every starter feed through the SSRF-safe client (needs outbound internet; run it from a machine that has
it), parses it and compares the detected language with the declared one. Exit status 1 if any feed fails, a
language mismatches or the static data validation reports problems.

```bash
export PATH=~/.local/node22/bin:~/.local/bin:$PATH      # developer machine
pnpm --filter @bantoozi/ops cli bundles:check                                   # offline data validation only
pnpm --filter @bantoozi/ops cli bundles:check --live \
  --user-agent 'BantooziBot/1.0 (+https://<PUBLIC_HOST>/bot)' --out reports/bundles-live
```

(`apps/ops/src/cli.ts`; `pnpm --filter @bantoozi/ops exec …` also works for the built tools, but `cli` is the
declared script.) `--out` writes `<base>.json` and `<base>.md`. **Verify:** the printed summary shows
`failed: 0, langMismatch: 0`. Replace dead feeds in the bundle data and re-run; do not ship a failing bundle.

---

## 14. Host reboot and catch-up

All long-running services have `restart: unless-stopped` and Docker is enabled at boot (section 1), so after a
reboot the stack comes back without action: `postgres` first, `migrate`/`seed` are `restart: "no"` and not
re-run, the application containers wait on healthy dependencies. Caddy keeps its certificates in the
`caddy-data` volume.

Catch-up: cron does not replay work missed while the host was down. The worker, on startup, enqueues every
overdue housekeeping job once (singleton keys), and `house.reconcile` repairs pending outbox, capture and rank
work; old outbox intents are drained and consumers tolerate duplicates. Host cron jobs (backup 02:30,
restore-test Sunday 04:00) do not catch up: after a reboot over those times, run `backup.sh` by hand.

**After a reboot:** `dc ps` all healthy; `curl -fsS https://<PUBLIC_HOST>/api/v1/readyz`; wait about 15 minutes;
the admin overview shows no backlog or overdue-job alert. If an alert fires, follow section 11. Planned reboot:
`dc stop worker api` first (drains within the grace period), take a manual backup, then `sudo reboot`.

---

## 15. Incident contacts and maintenance mode

Contacts (**owner** fills in, keep a copy outside the host):

| Role | Name | Contact |
|---|---|---|
| Release owner | `<NAME>` | `<PHONE / E-MAIL>` |
| Incident contact / on call | `<NAME>` | `<PHONE / E-MAIL>` |
| Alert recipients (`ADMIN_EMAILS`) | `<ADDRESSES>` | |
| Hosting provider support | `<PROVIDER>` | `<URL / PHONE>` |
| DNS / registrar | `<PROVIDER>` | `<URL>` |
| SMTP provider | `<PROVIDER>` | `<URL>` |
| Backup bucket provider | `<PROVIDER>` | `<URL>` |
| External uptime monitor | `<SERVICE>` | `<URL>` |
| Public support address (privacy and bot pages) | `<ADDRESS>` | |

The public support address on `/privacy` and `/bot` is still the placeholder `support@your-domain.example`
(`apps/web/public/privacy/index.html`, `privacy/sk/`, `bot/`, `bot/sk/`, each marked `OWNER:`): replace the text
of `#support-contact` in all four files before the launch release (**owner**).

Maintenance mode: `infra/scripts/maintenance.sh --env-file "$BANTOOZI_ENV" on|off|status`. While it is on,
Caddy answers every public route (the site, `/login`, the whole `/api/` surface) with **503**, a static
"Bantoozi is in maintenance" page and `Retry-After: 300`; only `/api/v1/readyz` is still proxied, and the API is
reachable inside the compose network. The switch is the file `/data/maintenance/on` in the `caddy-data` volume,
checked on every request, so it survives a restart or recreate of the caddy container and a host reboot. `on`,
`off` and `status` are idempotent (`status` prints `maintenance: on` or `maintenance: off`). `deploy.sh` turns it
on itself when a failed smoke leaves compatibility with the expanded schema undemonstrated (section 2), and logs
it; **it never turns it off**: verify the site, then run `off`. Use it by hand at the start of a recovery
(section 4.4 step 1) and for any planned window.

---

# Launch checklist (spec 11 §9)

Statuses as of 2026-10-11, end of M8 (local production-like rehearsal; no host access). **owner** marks items that need the owner or the real host.

| # | Item | Status |
|---|---|---|
| 1 | All milestones through M8 are done. G1 decisions are applied in production settings. | Partly. M0–M7 are merged to `main`; M8 is done on branch `claude/m8-ops` (not yet merged). Applying the G1 values in production settings: **owner** (§9). |
| 2 | G1 has an `owner_pilot` or `multi_person_beta` PASS under spec 10 (accepted Q13). A passing owner-only pilot is sufficient for this initial beta; additional raters are not a prerequisite. All existing quality, cost, security, operational and recovery gates still pass. | Done. `owner_pilot` PASS on `golden-v3`, 2026-10-08 (`apps/eval/reports/G1-2026-10-08-decision.md`). The other gates are items 4, 8 and 12–15 and `docs/SECURITY-CHECK.md`. |
| 3 | `TYPESAFE_MODEL` is pinned. The daily budget is set from the G1 recommendation. | Partly. Production config refuses an unpinned `TYPESAFE_MODEL` (D-2). Setting the daily budget from the G1 recommendation: **owner** (§6). |
| 4 | Off-site encrypted backups and offline keys restore successfully, including roles/RLS, deletion-ledger replay and queue recovery; measured RPO/RTO accepted. Every alert and recovery transition fired in a drill, including a stopped worker and an unreachable host. | Local drill done: `backup.sh`/`restore-test.sh` (drill 64/0, retention 18/0, fault injection 35/0) and the restore release smoke (23/0), including roles/RLS, deletion-ledger replay and `recovery:prepare` (`5a86198`, `3f0858b`). Every `house.alerts` rule fires, de-duplicates and re-arms in tests, including a stopped worker (`f0a24d1`). Off-site bucket, offline keys, measured RPO/RTO on the target and the unreachable-host monitor: **owner**. |
| 5 | The admin account exists. 10 invites were created for testers. The waitlist form works. | The waitlist form is covered by the M6 E2E smoke. Creating the admin account and 10 tester invites on production: **owner** (§7). |
| 6 | Starter bundles verified (every feed fetches, languages are correct). | Done. 56/56 feeds fetch with the declared language (`docs/launch/bundles-live-2026-10-11.md`, `c48a5e4`). |
| 7 | Privacy page describes providers, remote images, deletion grace, backup expiry, invite and waitlist retention, and export; contact and `/bot` page published. SMTP SPF/DKIM/DMARC and delivered login mail verified. | Partly. `/privacy` and `/bot` (en/sk) are published with the login link (`a22feab`). The support contact address, SPF/DKIM/DMARC and a delivered login mail: **owner** (§12). |
| 8 | Load sanity (M8-T8): 20 simulated users x 50 feeds x 10 cards for 1 hour (generated fixture feed server with 1,000 feeds and 5 new items per feed per hour, fake TypeSafe server with `latencyMs: 300`, separate test Compose project/DB with `NODE_ENV=test`, `RATE_LIMITS_ENABLED=false`, `FETCH_ALLOW_PRIVATE=true`, never relaxing production config). On the target box: CPU < 70 %, p95 `GET /articles` < 300 ms, no queue-backlog alert. On a local production-like stack: the same p95 and backlog criteria; CPU reported, not gated. | Done locally (CPU reported, not gated). Realistic profile (gate, D-187): p95 32/34/45/74 ms over 330–553 list samples per phase, no backlog alert, no 5xx (`docs/launch/load-60min-realistic-2026-10-11.md`); stress profile (reported): p95 81/127/184/212 ms (`docs/launch/load-60min-stress-2026-10-11.md`). Run with `pnpm --filter @bantoozi/ops cli load:run --profile realistic --duration 60`. On the target box: **owner**. |
| 9 | Deploy/rollback drill preserves live reader state; full host reboot starts healthy dependencies, catches up missed cron work and drains old outbox intents without duplicate side effects. | Done locally: the deploy drill (50/0) keeps reader state across a redeploy and a rollback, and a whole-stack restart runs a missed cron job once and delivers an outbox intent from the outage once (`1c4e986`). Rollback to a real previous release and a real host reboot: **owner**. |
| 10 | Two workers pass concurrent ingestion, merge, revision, quota, budget and origin-throttle tests; load test uses the actual configured pool/memory budget, and at least one high-latency/failing provider scenario proves degraded reading stays available. | Done at the database level: concurrency tests with separate worker-role pools for origin throttling (`packages/db/test/ingest/origin-limiter.int.test.ts`), ingestion (`articles.int.test.ts`), merges (`merge-articles.int.test.ts`), quotas (`apps/api/test/quotas.int.test.ts`) and budget (`packages/db/test/engine/store.int.test.ts`). No test boots two full worker processes. The load test uses the configured pools, and its failing-provider phase kept reading available (0 5xx). |
| 11 | Production DNS/TLS, system time synchronization, external uptime/backup monitor, alert recipient, release owner, incident contact and the maintenance/restore instructions are recorded. | **owner**: DNS/TLS, time sync, external uptime and backup monitor, alert recipient, release owner, incident contact (§1, §11, §15). |
| 12 | Fresh-instance bootstrap and upgrade from the previous schema both pass migration/seed tests; runtime images contain required CLIs/artifacts and no service has another role's credentials. | Done: upgrade from the previous schema with data (`migrate-upgrade.int.test.ts`), fresh bootstrap and parity (`migrate.int.test.ts`, `schema-parity.int.test.ts`), seed idempotency (`seed.int.test.ts`), per-service credentials (`compose-credentials.test.ts`), worker CLI and backup tools inside the production images (deploy and backup drills) (`9d916de`). |
| 13 | User-selected training infers only selected articles, active feeds infer new arrivals, and all-off feeds run ingestion/reading/bookmark capture with zero article-provider calls. | Done: all-off feeds make zero provider calls end to end (`all-off-zero-calls.int.test.ts`, `9d916de`); training and active demand tests (`foundation.int.test.ts`, `backfill.int.test.ts`, `ingestion.e2e.test.ts`); the load run's all-off phase made 0 inference calls. |
| 14 | A bookmarked article's full available text/HTML survives source deletion, cold maintenance, unsubscribe and backup restore; export checksum matches, and failed/partial capture is honest. | Done: retention, cold maintenance and unsubscribe tests (`house-retention-b.int.test.ts`, `articles-actions.int.test.ts`), export checksum (`export-checksum.int.test.ts`), restore of a cold bookmark in the backup drill, honest failed/partial capture (`bookmarks.int.test.ts`). |
| 15 | Per-user-feed image opt-in survives reload/unsubscribe without changing another user's policy; archived content never fetches remote media automatically just because it was previously saved. | Done: the remembered choice survives unsubscribe and re-subscribe without touching another user (`image-policy-unsubscribe.int.test.ts`); capture fetches only the feed, page and robots.txt (`capture-no-media-fetch.int.test.ts`); render gating in the web tests. |
