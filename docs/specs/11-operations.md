# Spec 11: Operations: deploy, housekeeping, backups, monitoring, security

Status: **binding**. **Intent:** run the whole service on one self-hosted box with no GPU and minimal
spend. Keep the data safe with tested backups. Clean up after itself automatically, and tell the admin
when something needs a human, before users notice.

---

## 1. Target host

- **Size:** 8 vCPU (dedicated), 16–32 GB RAM, ≥ 160 GB NVMe, Ubuntu LTS. Budget provider; a few tens
  of € per month.
- **Open ports:** only 22 (SSH, key-only), 80 and 443. `ufw` default-deny inbound, plus verified
  Docker firewall rules: a published container port can bypass ordinary host firewall assumptions.
  Database, translation, API and worker metrics ports are internal-only; test from outside the host.
- **Host packages:** Docker Engine + Compose plugin, `unattended-upgrades`, `rclone` + `age` (backups),
  `fail2ban` (SSH), synchronized system clock. Host cron explicitly sets `CRON_TZ=UTC`.

---

## 2. Compose stack (`infra/compose.yml`)

| Service | Image | Memory limit | Notes |
|---|---|---|---|
| `postgres` | `postgres:16` | 6 GB | volume `pgdata`; `infra/postgres/init.sh` mounted into `/docker-entrypoint-initdb.d/` (spec 02 §1.1) with `POSTGRES_PASSWORD` and `BANTOOZI_{OWNER,APP,WORKER}_PASSWORD` from `.env`. Config: `shared_buffers=1536MB`, `work_mem=8MB`, `maintenance_work_mem=256MB`, `max_connections=100`, `wal_compression=on`. Not published to the host network |
| `migrate` | dedicated migration target, command `pnpm db:migrate` | 512 MB | includes migration CLI + SQL artifacts; runs once per deploy with restart `"no"`; `api`/`worker`/`worker-laya` depend on successful completion |
| `api` | built from `apps/api` | 768 MB | healthcheck `GET /api/v1/readyz` on its internal port |
| `worker` | built from `apps/worker` | 1.5 GB | `WORKER_QUEUES=*` (every queue except the `.laya` ones); healthcheck `GET /healthz` on its metrics port (503 when its heartbeat is older than 2 min). The image ships `packages/questions/library/*.json` beside the built `packages/questions`, since the seed loads the card library at runtime (D-50) |
| `worker-laya` | the `worker` image | 3.5 GB | Compose profile `laya` (M9; `deploy.sh` refuses the profile until M9 registers the Laya handlers, D-197): enable it before setting `engine.laya`, which requires its heartbeat (spec 08 §9). Keep it while that setting lists a language and, after the setting is cleared, while **Laya work is outstanding**: a created, retrying or active job in either `.laya` queue, or an undelivered (pending or leased) `job_outbox` row for one, which the relay could still publish. Once a language is removed, each such job moves to the ordinary queue without an engine call (spec 04 §9), so this drains. `WORKER_QUEUES=article.enrich.laya,analysis.process.laya`; the only process that loads the checkpoint (spec 04 §9), from pinned, checksummed files on a read-only model volume. Own heartbeat and healthcheck on its metrics port |
| `libretranslate` | `libretranslate/libretranslate:latest` (pin a digest) | 3 GB | `LT_LOAD_ONLY=en,sk,cs`, `LT_DISABLE_WEB_UI=true`. Compose profile `translate`: enable it before setting a language mode to `translate` or `card_text_mode` to `english` (the API refuses those settings unless LibreTranslate answers its health probe, spec 08 §9), and keep it while such a setting is on |
| `ollama` | `ollama/ollama:<version>` (pin a digest) | `OLLAMA_MEM_LIMIT` (8 GB) | Compose profile `ollama` (D-263): a local Ollama server instead of the cloud API. Needs `OLLAMA_BASE_URL=http://ollama:11434` in the env file (an admin-stored Ollama URL must stay https), any `OLLAMA_API_KEY` and local `OLLAMA_MODEL_FAST`/`STRONG`, which `deploy.sh` pulls. `deploy.sh` layers `infra/compose.gpu.yml` (NVIDIA: `nvidia-smi` sees a GPU and Docker has the `nvidia` runtime; `OLLAMA_GPU_DEVICE` pins one card) or `infra/compose.vulkan.yml` (DRI render nodes: Intel/AMD) per `BANTOOZI_GPU` (`auto`, `cpu`, `nvidia`, `vulkan`), and warns when the model still loads on the CPU. No published port |
| `caddy` | `caddy:2` | 256 MB | TLS (Let's Encrypt), serves `apps/web/dist`, reverse-proxies `/api/*` → `api:3000`, security headers (§7). It receives `HTTPS_PORT` (default 443) and an explicit `http://` block redirects permanently to `https://$PUBLIC_HOST:$HTTPS_PORT{uri}`, always with the port, so a rehearsal on a non-default port keeps it (D-205) |

- **Rehearsal S3 stand-in:** the `minio` service (rehearsal only) has a healthcheck (`mc ready local`, every 3 s, up to 20 retries); `deploy.sh` starts it with `up -d --wait` and creates the backup bucket as a directory of its data root once it is healthy (D-205).
- **Logging:** the Docker `json-file` driver with `max-size=20m`, `max-file=5` for every service.
- **Restart policy:** `unless-stopped` for long-lived services; `"no"` for migrations/seeding. Pin
  every production image by digest and retain the previous release's image digests.
- **Resources:** `work_mem` is per sort/hash operation, not a per-server cap. Reserve ≥ 3 GB for host,
  filesystem cache and deploy/backup overhead; prove the enabled profile fits 16 GB. Two workers plus
  translation/Laya require the 32 GB profile or reduced limits; `worker-laya` counts as a second
  worker. Each API pool starts at max 10, each worker at max 24 (a query pool of 10 and a feed-lock pool of 14 shared by the 16 `feed.fetch`
  consumers; pg-boss's own pool of 4 is counted separately; D-179), and `worker-laya`, whose two queues run at concurrency 1, at max 6. Account
  separately for pg-boss and migration/backup connections and keep their **combined** maximum below
  80. Add an explicit total pool budget before enabling a second worker. No long-lived job lock may
  exhaust the query pool.
- **Persistence:** named volumes for Postgres, Caddy `/data` and `/config` (certificates), pinned
  translation models and the Laya checkpoint. Healthchecks gate dependency startup; readiness
  includes migrations, DB and worker queue/outbox initialization, not successful external model
  calls. Run app containers as non-root, with a read-only filesystem except explicit tmp/model
  volumes, and no Docker socket.
- **Compose project name:** every compose file sets a top-level `name:` (`bantoozi-prod`, `bantoozi-dev`,
  `bantoozi-test`), and host ports come from env, so stacks never replace each other's containers.
- **Secrets:** protected host secret files/environment (mode 600) contain database-role passwords,
  SMTP/session/metrics secrets, backup encryption/bucket settings and the provider master-key ring
  `PROVIDER_MASTER_KEY_ID` / `PROVIDER_MASTER_KEYS` (specs01/04). Provider API keys are encrypted in
  `provider_credentials`; `TYPESAFE_API_KEY` / `OLLAMA_API_KEY` are optional bootstrap inputs, not an
  admin-readable plaintext settings store. Explicitly disabled credentials never reactivate through
  env fallback. Admin key submission is write-only and must be redacted before logging.
- Compose passes each service only its declared variables; the API never receives owner/worker
  database or backup credentials. Authorized API encryption and worker decryption get only the
  required host keyring; browser/build/export/logs get none of it. Keep encryption keys out of database
  dumps and back them up separately with offline access. Retain old key IDs for every still-retained
  backup that needs them, and drill rotation/decryption/revocation against fake providers. Application
  revocation disables local use; revocation at the provider requires its own dashboard/API operation.
  Never echo interpolated Compose config or put secrets in command arguments.

---

## 3. Deploy (`infra/scripts/deploy.sh`)

1. Resolve the approved release tag `vYYYY.MM.DD-N` to a commit, acquire a deploy lock and verify a
   clean checkout. Build immutable API/worker/migration/Caddy images with the frozen lockfile; static
   web assets are inside the Caddy image, not overwritten in a shared volume during a live deploy.
2. Validate required secrets (including `DELETION_LEDGER_PATH`, `DELETION_LEDGER_RECIPIENT` and
   `DELETION_HMAC_KEY` and a `DELETION_LEDGER_PATH` inside `/var/lib/bantoozi/ledger/`; example placeholders are refused, D-190, D-202). `ADMIN_EMAILS` is optional (bootstrap only, D-215): it is no longer required, but a placeholder in it is still refused. The first admin comes from the setup token (spec 08 §2.1), and the post-deploy smoke test only **warns** when no active admin exists yet. Validate also the enabled profiles, check free disk/connection budget, and record
   the previous image digests, schema version and a fresh successful encrypted pre-deploy backup. The
   `backup-tools` image is built first (a failed build stops the deploy), so a first image build cannot
   time out inside `backup.sh` (D-205).
3. Start healthy Postgres, then run the one-off migration image. Migrations acquire a database
   advisory lock and use bounded `lock_timeout`/`statement_timeout` (30 s and 5 min, set when the
   connection opens, so they also bound the wait for the advisory lock; a timeout fails the job with
   SQLSTATE 55P03/57014, the interrupted transaction rolls back and a re-run converges). They must
   be **backward compatible** with the previous release: expand/contract, never drop a column in the
   release that stops using it. Failure stops deployment before application replacement. Run the
   seed command with its explicitly scoped role; runtime images must contain the command/artifacts
   they invoke.
   Seeding is idempotent: insert missing topics/question sets/library cards and a missing
   `language_modes` row (from the worker's `LANGUAGE_MODES`, spec 02 §2), but never overwrite admin
   settings or switch an existing active question set merely because a release was deployed.
4. Stop consumption and outbox claiming in the old workers, drain bounded in-flight work, then replace
   application containers. On SIGTERM API stops accepting requests, workers stop claiming new jobs,
   and both close pools after drain. Compose `stop_grace_period` exceeds the documented longest
   graceful deadline; forced shutdown relies on leases/idempotency, never on assumed exactly-once
   completion. Start the translation profile when required (and, in a rehearsal, wait for `minio` to be healthy and create its bucket before the application containers start, D-205), then API/worker/Caddy, and `worker-laya`
   when the `laya` profile is enabled. Step 2 fails if `engine.laya` lists a language, or Laya work
   is outstanding (§2), without that profile, so no work waits on a queue nothing consumes. It
   likewise fails if a language mode (the stored one, or `LANGUAGE_MODES` before the seed stores it)
   is `translate` or `card_text_mode` is `english` without the `translate` profile. The stored values
   are read through the Postgres container before anything is replaced. A fresh instance (no database
   yet) and a local rehearsal without `BACKUP_S3_*` skip the pre-deploy backup and log why (D-180).
5. Verify `/api/v1/readyz`, static asset routing, login-page delivery, worker heartbeat, outbox
   dispatch and one queue traversal: a `house.purge-auth` outbox intent that must be delivered and
   complete as a pg-boss job (a rehearsal also plants an expired `rate_limit_buckets` row that it must
   delete; a feed fixture would need `FETCH_ALLOW_PRIVATE`, which production refuses). Wait up to
   120 s for readiness. Record release
   SHA/digests and smoke results in the deploy log. The single-host beta allows a brief maintenance
   window; do not promise zero downtime.
6. If smoke fails, restore previous **application images** while retaining compatible expanded
   schema; do not blindly reverse migrations or restore the database over writes made after deploy.
   If compatibility cannot be demonstrated (the restored images are not healthy), `deploy.sh` turns
   maintenance mode on and it stays on until the operator turns it off. Maintenance mode is the flag
   `/data/maintenance/on` in the `caddy-data` volume (`infra/scripts/maintenance.sh on|off|status`):
   Caddy answers every public route with a static 503 page and `Retry-After: 300`, except
   `/api/v1/readyz`. Then use the recovery runbook. After restoring, `deploy.sh` logs the commit of the
   restored images and that the requested release is NOT running (on a rollback the restored images are
   the newer release's). A rollback is a deploy of the older release from its own checkout; it is ready over
   the expanded schema because readiness accepts migrations newer than the release bundles (D-207).

**Proxy paths:** Caddy preserves `/api/v1/*` when proxying to the API (no accidental prefix stripping),
serves hashed assets with immutable caching, and serves `index.html`/service worker with revalidation.
SPA fallback must not turn missing API/assets into HTML 200 responses. `/metrics` is authenticated and
internal by default; `/readyz` exposes no secrets. `/bot`, `/privacy` and the support contact exist.

---

## 4. Backups (`infra/scripts/backup.sh`, host cron at 02:30)

**Beta recovery targets:** recovery-point objective (RPO) ≤ 24 h and recovery-time objective
(RTO) ≤ 4 h, **accepted by the owner** and verified on the target-size dataset. Tighter RPO would
require WAL archiving/PITR and is not provided by a daily dump. Benchmark restore with the expected
retained-bookmark corpus, since saved full content persists beyond the ordinary article-body window. A healthy daily backup meets the stated recovery target; a missed
backup immediately increases exposure and must alert rather than being reported as covered.

- Under a host lock, use `pg_dump -U postgres -Fc bantoozi` with a PostgreSQL 16 client (run inside
  the pinned `postgres` image, so no client is installed on the host) and superuser access, preserving every schema and all RLS-protected rows (`pgboss` and `eval` included). Capture
  `pg_dumpall --globals-only --no-role-passwords` as well: a single-database dump does not include
  cluster roles. Restore role passwords from the separately encrypted deployment secrets with
  `recovery:role-passwords` (all three roles or none); the restore drill sets throwaway passwords and proves
  each role logs in over password-authenticated loopback TCP (D-196).
  See [PostgreSQL 16 pg_dump](https://www.postgresql.org/docs/16/app-pgdump.html) and
  [pg_dumpall](https://www.postgresql.org/docs/16/app-pg-dumpall.html).
- Serialize with account erasure: before the dump, take the session advisory lock
  `ERASURE_BACKUP_LOCK_KEY` (`packages/shared/src/erasure-lock.ts`) and hold it until the deletion-ledger
  copy is shipped and verified and the manifest is uploaded and verified, then release it (D-190). `house.purge-users` holds the same
  lock around each user's whole purge (tombstone append to final commit), so every purge falls wholly
  before a backup (user absent from the dump, tombstone in its ledger copy) or wholly after it. The
  backup waits at most `BACKUP_ERASURE_LOCK_WAIT_S` (default 300 s) and otherwise fails with
  `backup_failed`; a purge waits at most 60 s within its run budget, then stops the run as incomplete
  and retries the user on the next run, never skipping the tombstone (D-189).
- Stream dump, globals and a manifest into `age` encryption; do not retain an unencrypted dump on
  disk. The manifest includes UTC start/end, commit/image digests, schema version, backup ID and
  ciphertext checksums. Use `set -euo pipefail`, temp files + atomic rename, and restrictive modes.
  An incomplete dump is never named or advertised as a valid backup. Objects are
  `<prefix><id>/{dump,globals,manifest}.age` with `<id>` the UTC time `YYYYMMDDTHHMMSSZ`; the
  manifest is uploaded last and is the commit point, and a failed run's parts are marked
  `backup-failed` and pruned after 2 days. The encryption and the S3 client are `apps/ops` run
  through `tsx` in the `backup-tools` image (`age-encryption` and its own SigV4 client; D-181).
- Upload encrypted artifacts to an S3-compatible bucket and verify object size/checksum before
  emitting `backup_ok`. Posting `backup_ok` (and the restore test's `restore_ok`) is retried 4 times, 5 s apart;
  if it is still not recorded the script exits 1 even though the backup is verified, because a missing event
  would raise the stale-backup alert (D-205). Keep encryption recovery keys outside this host/bucket and test recovery
  from those keys. Back up encrypted deployment secrets on change, including every provider
  master-key version needed by retained backups, plus deploy/restore instructions; Caddy state
  can be backed up or deliberately recreated from documented DNS/TLS configuration.
- **Retention:** 7 daily, 4 weekly (Sunday), 6 monthly (1st), enforced locally and remotely by UTC
  backup IDs; one backup may satisfy multiple buckets. Daily keeps every backup of the 7 newest UTC
  dates that have one; weekly and monthly keep the newest backup of each of the 4 newest Sundays and
  6 newest 1st-of-month dates that have one. Prune only after a verified replacement,
  never delete the last known-good restore-tested backup. Bucket permissions isolate routine writer
  and retention-delete credentials. An off-site successful upload, not a local file, meets the RPO.
- **Weekly restore test** (`restore-test.sh`, Sunday 04:00 UTC): provision an isolated empty Postgres
  16 instance, restore roles/bootstrap ownership, create the database, then `pg_restore
  --exit-on-error` with ownership/ACLs intact. Use `psql -v ON_ERROR_STOP=1` for SQL/bootstrap scripts.
  See [PostgreSQL 16 pg_restore](https://www.postgresql.org/docs/16/app-pgrestore.html).
  The test has no production network egress, SMTP, provider keys or exposed public API: the saved
  release's api and worker images (from the manifest) run with `--network none` against the restore
  over its unix socket, with an SMTP sink inside the api container (D-182).
- Verify expected schemas/extensions/migration version, FK validity, sequences, active-set seeds,
  restored RLS/role separation with two fixture tenants (as `bantoozi_app` after `SET LOCAL ROLE`;
  the throwaway database trusts its local socket because no role passwords are restored), and data
  bounds recorded in the manifest (table row counts within `max(5, 10 %)`, since rows change while a
  dump runs).
  A legitimately empty or quiet installation passes; “latest article < 24 h old” is not a backup
  integrity condition. Start the saved release against the restore with fake mail/providers and run
  login/read/rank/outbox smoke tests. The smoke account is created in the throwaway database first, because a
  restored `settings.signup_mode` (for example `closed`) overrides the smoke environment and only an
  existing account always receives a login code (D-195). Include a cold bookmarked snapshot whose publisher fixture
  returns 404: authorized full-text/HTML reads and exports must match the pre-backup checksum, with
  no refetch. Verify encrypted provider credentials against a fake provider using the separately
  restored key material, never production inference. Record restore duration and backup age.
- Scripts emit bounded redacted `ops-event`s and nonzero exit codes on failure. Alerts are sent only
  by `house.alerts`; an **independent external heartbeat monitor** also checks backup completion and
  public readiness so host/DB/worker failure cannot silence its own alarm.

### 4.1 Actual recovery runbook

1. Put public traffic in maintenance mode; stop workers and deny outbound provider/mail traffic.
2. Select and verify an off-site backup, decrypt with the offline recovery key, restore globals,
   roles/secrets and database into a new volume, then run the same verification as the weekly drill.
3. Apply the separately retained deletion ledger (§5.1) before serving any restored user data.
   Revoke restored sessions/login codes so old revocations cannot be undone by restoring a snapshot.
4. Do not immediately resume restored `pgboss` jobs: cancel/expire stale active leases through the
   pinned queue API, reset outbox/origin leases, and run reconciliation against current domain rows.
   `recovery:prepare` does this in SQL: an `active` `pgboss.job` row, whose outbox intent was already
   delivered and is therefore the only copy of its work, becomes runnable again (`retry` with
   `start_after = now()`), whatever its retry count: an exhausted `retry_limit` is raised to
   `retry_count + 1` so pg-boss runs it once more; handlers tolerate the repeated run (created and retry
   jobs stay). Outbox and origin leases are cleared and `running` `analysis_requests` return to
   `pending` (D-192, D-196).
   Rebuild eligible work, skipping deleted users, superseded revisions and no-longer-authorized
   subscription inference generations; rebuild pending local bookmark captures separately. Disable delivery of old
   authentication/operational emails; re-enable only newly generated messages after recovery.
5. Restore model spend conservatively: remote provider usage after the backup still occurred. Keep
   paid inference paused until daily spent/reserved totals are reconciled or the UTC budget resets.
6. Re-enable workers and egress, verify read/write/queue/backup checks, reopen traffic, and record the
   actual loss window and recovery duration. A database restore is an operator action, never an
   automatic response to a transient application error.

---

## 5. Retention (enforced by housekeeping, §6)

| Data | Kept |
|---|---|
| `articles` (+ feed_items, facets, answers) | Arrival = the latest `feed_items.last_seen_at` (the last fetch whose feed still listed the item; else `articles.first_seen_at`), so an item a feed still lists is never purged and re-ingested as new. **21 days** after arrival when no user ever engaged with it (`UNOPENED_RETENTION_DAYS` = rank window 14 + 7; engaged = opened, an individual read — a `feedback_events` `read`, not a bulk `mark_read` —, a rating, a bookmark or a label) unless a feed in `eval.rater_feeds` or subscribed by the evaluation user carries it; otherwise **90 days** after arrival. A bookmark, a like or a label by any user keeps it while that state exists; dislikes alone keep it until `max(180, model.historyDays)` days after the latest dislike (and never less than 90 days after arrival). An `analysis_requests` row younger than 180 days, an `eval.*` reference or an uncollectable snapshot also keeps it (D-253). `pnpm worker-cli purge-report` prints what each rule would delete, deleting nothing |
| unprotected hot `article_bodies.body_text` / `body_html` | 30 days after extraction and after the article's latest carrier arrival; clear only after bookmarked content has a durable snapshot, and never clear content needed by a pending or failed capture; `body_lead` remains |
| `article_snapshots` full saved text/HTML | indefinitely while at least one live bookmark references that immutable snapshot; cold after 30 days, never shortened or replaced by a lead |
| `article_translations` | with the article |
| `engine_calls` | 180 days (aggregated into `usage_daily` live) |
| `engine_reservations` | settled: 180 days, purged with their `engine_calls`. A `reserved` row past `expires_at` becomes `uncertain`, never refunded, because the attempt may have reached the provider; a reservation whose attempt was cancelled before its send is deleted at once (D-95). An `uncertain` row that provider usage has not reconciled is settled at its `reserved_usd` 7 days after its budget `day`, then follows the settled retention |
| `usage_daily` | aggregate totals forever; user attribution is removed on hard deletion (§5.1) |
| `user_article` reader state | while both user and article exist; unprotected articles expire after 90 days. Read items archived after 31 days; unread cap 1,000 per user per feed, subject to protected-state rules below |
| `analysis_requests` frozen inputs/results | 180 days from creation, covering the matching learning window; terminal/cancelled requests beyond that window are purged after dependent training/receipt references are handled |
| `feedback_events` | up to 365 days, or until the associated unprotected article/user is deleted |
| delivered `job_outbox` rows | 7 days; pending/failed intents remain until resolved or their domain entity is deleted |
| completed/failed pg-boss jobs | 7/30 days respectively using pinned pg-boss maintenance settings; failures counted before removal |
| `login_codes` | 1 day after expiry |
| `invites` | unused: 30 days after `expires_at` (a linked `waitlist.invite_code` becomes null); used: kept for invite accounting while either account exists, subject to erasure (§5.1), and deleted once both `created_by` and `used_by` are null |
| `waitlist` | deleted at signup (spec 08 §2.1); otherwise 365 days after `created_at`, including rows whose invite expired unused |
| `rate_limit_buckets` | 8 days after `window_start`, a fixed bound above the longest limiter window (1 day) plus the 1-day grace, because the table stores no window length |
| `origin_fetch_state` | 7 days after `last_used_at`, only once request/feed start slots, cooldown and leases have passed, Crawl-delay is zero and the decayed learned floor is below one second; applicable source policy survives quiet feeds scheduled ten days apart (D-256) |
| `feeds` | while subscribed. 30 days after the last subscription ends (`unsubscribed_at`), a feed with no `feed_items`, `analysis_requests`, `eval.rater_feeds` row, explicit `allow`/`block` `user_feed_preferences` row or merged feed pointing at it is deleted with its `feed_cards` and `inherit` preference rows. A bookmarked article keeps its `feed_items`, and so keeps its feed. A remembered image choice keeps its feed until the user resets it to `inherit` or is erased, so re-subscribing to the same URL finds the same choice (spec 08 §4.2) |
| `story_clusters` | until the cluster has no member article and no `mute_story` rule names it (such a rule always has an expiry, at most 30 days after the mute that set it) |
| non-public `interest_cards` | while held. `house.retire-cards` retires an unheld card; 30 days later its `card_answers` are deleted, then the card itself unless a library version, publication request or eval row references it (§6) |
| `api_mutations` idempotency/undo receipts | until `expires_at` (at least 7 days after creation) |
| `sessions` | 30 days after expiry or revocation |
| deleted users | hard-deleted 7 days after `DELETE /me`; encrypted historic backups normally age out within 6 months and are never served directly; the newest restore-tested backup is kept until a newer one passes its restore test, so it can be older if backups or restore tests stop, and the privacy page says so (D-201) |
| `eval` schema | while needed as the golden set, subject to rater erasure (§5.1) |
| `metrics.daily` settings | 90 days of aggregate snapshot metrics (spec 10) |

**Retention precedence:** bookmarks, their retained snapshots/unexpired Undo pins, current non-null
ratings, explicit labels, retained analysis requests and golden-set references protect an article from the 90-day purge; historic undone feedback does not. Retention
windows are maxima, not promises that child rows survive deletion of their parent. Extraction after
30 days does not run solely to repopulate deliberately purged unbookmarked full bodies. An explicit
bookmark capture/retry may fetch missing content; a saved snapshot never depends on refetch. `body_lead` and translated
lead remain while the article exists. Rate/label examples needed for future training use current
`user_article` truth; they must not depend on an event older than the event-retention window.

Archive is reversible presentation state, not deletion. Exclude bookmarked/rated/explicitly labelled
rows from automatic archive. Count distinct unread article IDs per subscribed feed, newest by that
feed's arrival (`feed_items.first_seen_at`, then `id`); archive only rows that lie beyond 1,000 in **every** feed
through which that user receives them. Since archive state is per article, applying each feed's cap
independently would wrongly hide a newer item in another feed. Protected rows may exceed the cap. A cleared rating is not protection, and only unprotected unread rows are counted toward the cap. The count runs per subscription (a lateral subquery over the feed's items) through the partial index `user_article_unread_cap_idx (user_id, article_id) WHERE read_at IS NULL AND archived_at IS NULL`, and users with `deleted_at` set are left out (D-204).

Delete eligible snapshot rows before their owning article; the snapshot article FK deliberately
blocks deleting saved content accidentally. Unreferenced snapshots still within their grace can
therefore temporarily extend the parent article's lifetime.

All purge jobs use short committed batches with keyset pagination and a per-run 5-minute work budget;
unfinished work continues next run. Recheck protection with article row locks before deleting. User
bookmark/rating/label mutations lock the same article row, so a concurrent save cannot lose its
article after reporting success. Count and alert on persistent FK failures rather than skipping them
forever. Cluster sizes/representatives, feed counts and ranking caches are reconciled after deletes;
a cluster left without members is deleted once no `mute_story` rule names it. Delete it under its
row lock after rechecking both conditions; clustering only joins a member's existing cluster, so an
empty one never gains members.

### 5.1 Account erasure and restore safety

Soft deletion immediately revokes sessions and suppresses user work, recommendations and outbound
mail; the 7-day undo via re-authentication is documented in the UI/privacy page. Hard deletion locks
the user and rechecks `deleted_at` so a concurrent restore cannot be deleted accidentally. Enumerate
and test the deletion graph: subscriptions/cards/labels/rules, reader state/events/models/suggestions,
private-card answers/examples, bookmark capture state/snapshot references/Undo pins, per-feed media settings,
sessions/codes, user-specific outbox/jobs and cost attribution, and pre-account records that have no
user FK: delete the `waitlist` row with the user's email, clear `email`/`note` on invites the user
consumed, and delete unused invites bound to that email (clearing their email would unbind them).
Remove a snapshot only after its last
bookmark owner releases it; another user's preserved copy must survive this user's deletion. Remove
user holdings before private cards with RESTRICT references. Shared public feed/article rows remain,
and card publication requests stay as anonymized audit records (spec 02 §3.6), with `creatorUserId` in their authorization evidence set to null.

Before erasing the account, write an encrypted deletion ledger entry
`{userId, deletedAt, emailHmac}` that survives database restore: an append-only age-encrypted file
(`DELETION_LEDGER_PATH` on the persistent worker volume `/var/lib/bantoozi/ledger`, encrypted to
`DELETION_LEDGER_RECIPIENT`, one fsynced base64 line per entry) that every backup ships off-site as
`ledger/deletion-ledger-<backup id>.age` (D-172). `emailHmac` is the hex HMAC-SHA256 of the
normalized email under `DELETION_HMAC_KEY`, kept with the ledger, outside the database, so a replay can find
pre-account rows in a backup taken before signup; do not store the email itself or content in the ledger. Use an idempotent entry
key and keep every shipped copy from the oldest retained backup onwards (the kept restore-tested backup included), pruning only copies older than both that backup and 193 days, and none while no valid backup remains (D-193). Failure, or no configured ledger, defers hard deletion and
alerts the operator (`erasure.disabled` while users past grace wait; a run with any ledger append failure, deletion failure or card-reference block is incomplete, records `cursor: {failed: {ledger, db, blocked}, at}` and raises `erasure.failed` until a clean run, D-193); a production worker refuses to start without
`DELETION_LEDGER_PATH`, `DELETION_LEDGER_RECIPIENT` and `DELETION_HMAC_KEY` (D-188). A committed user purge must never lack its recovery tombstone. Account restore
and ledger creation are serialized by the same per-user lock: `purgeUser` holds the session advisory lock
`hashtextextended('erasure:' || user_id, 0)` for the whole purge (tombstone, every batch, final delete), sign-in
verification takes it as a transaction lock before re-checking that the account is still restorable, and the purge
also deletes the user's `pgboss.job` and `pgboss.archive` rows (D-200). Recovery replays the union of all shipped copies, deduplicated by entry id, before
public access; an entry acts on a restored user only when its id is that user's entry id and its `emailHmac` matches the
restored email under `DELETION_HMAC_KEY` (the recipient is a public key, so a ledger entry alone is not trusted), and the
replay reports skipped entries as `mismatched` (D-188). It deletes personal rows again (including the waitlist rows and email-bound invites
matching `emailHmac`, handled as above) and clears restored queued work. Ledger storage access is
operator-only and is included in the restore drill.

Null user attribution in engine audit rows, remove personal prompt text/examples from any retained
payload, and fold the user's `usage_daily` amounts into the platform bucket transactionally before
deleting attributed rows. Keep spend totals correct; do not retain a permanently linkable deleted
user UUID under “anonymous statistics”. Delete golden-set rater data on a separately documented
rater-erasure request; “golden forever” does not authorize retaining personal identifiers forever.

### 5.2 Lossless saved-content storage and cold maintenance

Bookmark preservation takes precedence over the 30-day hot-body cleanup. Accepted Q14 limits saved
content to full available readable text and sanitized HTML; image/attachment/other asset binaries
are excluded. External image display continues to use the per-user-feed preference and does not
create an archival guarantee. Saved snapshot payloads
are immutable, with separate per-user ownership references; article revisions, feed unsubscribe,
model changes and source disappearance cannot overwrite them. Removing the last bookmark permits
snapshot garbage collection after a 7-day unreferenced grace, and only after all unexpired
`bookmark_snapshot_pins` for exact Undo are gone. A new reference during that interval cancels collection. Account erasure removes personal ownership immediately at hard deletion; shared
content still owned by another user remains. Do not impose an undocumented automatic bookmark TTL.

Use ordinary PostgreSQL `text` columns for snapshot text and sanitized HTML, `STORAGE EXTENDED`, and
per-column `COMPRESSION lz4` when the pinned PostgreSQL 16 build supports it; otherwise explicitly
select `pglz` and record that capability in deployment diagnostics. Compression/decompression is
lossless and transparent to SQL reads/exports. PostgreSQL chooses whether compression is worthwhile;
small or incompressible values need not be compressed. Do not promise a compression ratio or a
separate gzip blob for every row. See [PostgreSQL 16 TOAST](https://www.postgresql.org/docs/16/storage-toast.html).

Compression can apply from first insertion. At snapshot age 30 days, `house.purge-bodies` verifies the
snapshot checksum/reference under the shared article lock, marks it cold, and removes only redundant
hot full-body copies whose pending captures are satisfied. Cold is a retention/storage-lifecycle
marker, not removal of archived payload or an instruction to fetch it again. Keep the full logical
content and all required rendering/export metadata. List/rank queries never select full snapshot
columns; retrieve them only for authorized article reading/export.

Setting column compression changes future writes, **not** existing stored values; copying a value
with `INSERT ... SELECT` can retain its previous compression. The schema's compression setting is
therefore not proof that every existing snapshot was recompressed. M8 records the actual supported
method and tests representative compressible and incompressible payloads with byte-identical reads;
any optional recompression migration must rewrite in small verified batches with enough disk for
WAL/temp copies. See [PostgreSQL 16 ALTER TABLE](https://www.postgresql.org/docs/16/sql-altertable.html).

Snapshot collection, unbookmark and capture completion lock in the same order (article, reader rows,
snapshot IDs). Set `unreferenced_at` when the last bookmark/Undo reference is released; clear it when
any reference is restored. Before removal expire elapsed Undo pins, then recheck **all** live user
references, remaining pins, pending capture generations and `unreferenced_at ≤ now() - 7 days`.
FKs must reject accidental deletion of referenced data. A pending/failed capture
must never be represented as successful permanent preservation. Capacity alerts include snapshot
logical/stored bytes, growth and backup/restore size; approaching the disk limit alerts the owner
and stops optional new captures cleanly before exhaustion rather than deleting existing bookmarks.

### 5.3 User choice and publication lifecycle

Housekeeping/re-enrichment/model upgrades never turn off/training subscriptions into active ones or
queue a historical feed-wide inference batch implicitly. They obey the same persisted user demand,
activation time and generation as normal ingestion (specs03/05). Explicit selected-article requests
have their own bounded lifecycle; reconciling them never expands their one-article authorization.
Cancel unresolved requests when their 180-day input-retention window expires; preserve their bounded
failure/cancellation record until the purge transaction removes related personal inputs. Save/extract, immutable archive reads
and compression are local operations and cannot trigger a provider merely because content exists.
Publication or retirement follows specs05/08: an eligible user-created card may be published with
creator approval, or after 30 days of creator inactivity under the accepted Q12 moderation policy.
Inactivity is measured from the creator's last activity, not a seven-day consent-request timeout.
Private training/examples are not automatically promoted into the public library, and operational
retention must not erase still-owned private cards or snapshots while publishing copies.

---

## 6. Scheduled jobs (pg-boss cron, all UTC; handlers in `apps/worker/src/handlers/house-*.ts`)

| Job | Schedule | Does |
|---|---|---|
| `feed.schedule` | every minute | spec 03 §3 |
| `house.rescore-degraded` | `*/10 * * * *` | recover the supported 14-day horizon (`RANK_WINDOW_DAYS`, spec 06 §11) fairly with persisted cursors/budget limits (spec 04 §5), including eligible deferred/exhausted match work and fallback answers; reuse current Call A, and reset terminal attempts only after their blocker changes (service failures while the primary engine is available and 6 h after they gave up, invalid requests never; D-80) |
| `house.expire-rules` | `5 * * * *` | delete expired rules; `user.rank {full}` for the affected users |
| `house.purge-auth` | `20 * * * *` | expired login codes, sessions, rate-limit buckets (8 days after `window_start`), idle `origin_fetch_state` rows, unused invites 30 days past expiry, used invites whose inviter and invitee accounts are both gone, waitlist rows older than 365 days and `api_mutations` receipts per §5, in bounded batches; `feed_auto_admissions` rows older than 7 days (D-252) |
| `house.reconcile` | `*/10 * * * *` | deletes match rows that can never run (extracted/translated article, no admitted active carrier, unleased, older than 60 minutes, no undelivered extract/translate/enrich/match intent; D-254); bounded repair of still-authorized inference, due pending/expired-lease `analysis_requests` within their 180-day retention, pending bookmark capture/outbox/match work and orphaned leases; expired `reserved` spend reservations become `uncertain` (§5); enqueue rank for due `user_article.next_rank_at` (deleted accounts skipped); enqueue the pending `house.reenrich`/`house.rematch` runs once, while the primary engine is available; nightly UTC window also refreshes feed subscribers/cards, cluster counts and `lang_hint` with persistent progress cursors |
| `house.archive` | `15 3 * * *` | archive unprotected read items whose latest carrier arrival (through the user's own subscriptions, else the article's first sighting) is older than 31 days and enforce the shared-article unread-cap rules in §5. Each archive is a versioned reader-state write: under the `user_article` row lock it rechecks the conditions, sets `archived_at` and increments `state_version`, so an older offline action gets `STALE_STATE` instead of silently undoing it (spec 08 §1.1). It records no feedback event |
| `house.purge-articles` | `30 3 * * *` | delete unreferenced articles whose latest carrier arrival is older than 90 days (§5), in batches of 5,000. Articles referenced from `eval.*` are never purged. Then delete member-less `story_clusters` that no `mute_story` rule names, and idle unreferenced `feeds` (§5), each under its row lock after rechecking the conditions |
| `house.purge-bodies` | `45 3 * * *` | §5.2: preserve/verify owned full snapshots, mark eligible snapshots cold, clear redundant unprotected hot text/HTML once both its extraction and the article's latest carrier arrival are 30 days old, and collect snapshots unreferenced for 7 days; repair snapshots whose last reference left no `unreferenced_at` mark; never erase pending or failed capture inputs |
| `house.purge-engine-calls` | `0 4 * * *` | first cancel `pending`/`running` `analysis_requests` older than 180 days under their row lock (`last_error_code = 'retention_expired'`, `completed_at` = now, lease cleared so a late completion fails its token check; account any upstream spend), settle `uncertain` spend reservations whose UTC budget day is at least 7 days before the run at `reserved_usd` (adding that cost to the day's `usage_daily`, plus the call when no `engine_calls` row references it), then delete `engine_calls`, settled `engine_reservations` and terminal `analysis_requests` 180 days after `completed_at` (else `created_at`), and `feedback_events` older than 365 days; clean delivered outbox rows and invoke bounded queue-history maintenance per §5 |
| `house.retire-cards` | `30 4 * * *` | set `retired_at` on cards with `visibility <> 'public'` (library and promoted cards are never retired) that have no holders (`user_cards`/`user_labels`) and are not referenced by `eval.rater_cards`; delete their `card_answers` 30 days later, then the card row itself unless a `library_card_versions`, `card_publication_requests` (kept as audit, spec 02 §3.6), `eval.rater_cards` or `eval.run_answers` row references it. Both steps recheck under the card row lock that reuse also takes (spec 05 §5.1): a card is retired only while unheld, and deleted only while still retired, unheld and unreferenced. The job also clears `retired_at` on a retired card that has a holder again. Forks keep working (`parent_card_id` becomes null), and queue, feed-card and suggestion rows cascade |
| `house.purge-users` | `0 5 * * *` | hard-delete users past the 7-day grace period, each under the erasure/backup lock of §4 (D-189) |
| `house.nightly-learn` | `0 1 * * *` | enqueue `user.learn` when the effective training-input hash changed since the last **attempt** (implicit signals, undo/unrate, context and 180-day expiry included); `user.suggest` for active users, per spec 06 (**built in M7-T4**) |
| `house.metrics` | `10 0 * * *` | online metrics (spec 10 §7) |
| `house.alerts` | `*/5 * * * *` | evaluate the alert rules (§6.1) and send **all** operational emails. Other components only record state: `engine.circuit`, `engine.budget_alerts`, `ops.events` |
| `house.reenrich` | on demand (admin changes the active enrich set, a language mode or `engine.laya`, or the model pin changes, §8) | re-enqueue still-demanded articles whose eligible carrier arrival is within `RANK_WINDOW_DAYS` (spec 06 §11), plus articles with a current completed explicit selection whatever their arrival (spec 05 §2), newest first, batches of 200 within budget, always in bulk priority and never through the LLM fallback; while the primary engine is unavailable the run is stored as a pending run in `house.progress` (at most 20) for `house.reconcile`; never opt users in or treat a model upgrade as permission for bulk untrained-feed inference. An article whose language is now `translate` and that has no usable stored translation for its current revision, and no facets from translated text, is sent `article.translate {modeChange, bulk}` first; when that translation is stored for an article with no facets under the active set, enrichment follows from it (D-204) |
| `house.rematch` | on demand (match set, card text mode, prefilter setting or model pin changed; a library card's topics corrected) | spec 05 §2: re-enqueue admitted pairs in `RANK_WINDOW_DAYS`, or on an article with a current completed explicit selection, whose answer is incompatible or a `prefilter` marker (one card's pairs for `{cardId}`), newest first, batches of 200 within budget, in bulk priority; an exhausted `invalid_request` row is revived only when its stored answer is incompatible with the current model, card text or match set; pending runs as for `house.reenrich`; full reranks for users active in 7 days; never opts users in |
| `house.translate-cards` | on demand (`card_text_mode` switched to `english`, or `{userId}` when that user's cards gain demand while it is on) | spec 07 §5, in bulk priority, under `HOUSE_RUN_BUDGET_MS` with the resumable cursor `{after}` in `house.progress`; an unrestricted run skips a card not translated within the last 6 h (`translation_attempted_at`), a `{userId}` run always retries (D-203) |
| `house.retranslate-skipped` | on demand (`POST /admin/translations/reprocess`, after the Ollama key, cap or budget is restored) | spec 07 §3: for still-demanded articles whose eligible carrier arrival is within `RANK_WINDOW_DAYS` and whose current-revision `ollama` row was skipped for a listed reason, send `article.translate {forceTier2, replaceSkipped}`, newest first, batches of 200 within the tier-2 cap and budget; items skipped again stay skipped until the next reprocess; never opts users in |

Every job is idempotent, logs `{job, durationMs, affected, remaining}`, and exposes a counter. Persist
last successful completion/cursor in `settings['house.progress']`. On worker startup, enqueue overdue
housekeeping once per job using its singleton key; cron alone does not replay work missed while the
host was down. Never use an unbounded scan/transaction for all feeds/users/articles. All resulting
rank/learn/re-enrich work uses the transactional outbox, and model-triggering scans respect budget,
active-user/retention checks and current per-user-feed inference demand. Bookmark capture is a
separate local queue and remains available when all inference modes are off.

### 6.1 Alerts (emails to the active admins, de-duplicated: each alert at most once per 6 h until resolved)

Recipients are the emails of all active admin users (`role='admin'`, not soft-deleted), ordered; `ADMIN_EMAILS` is the fallback only while there is none or the lookup fails, and with neither the run logs that alerts cannot be sent (M8b, D-215).

The engine alerts count only classification calls (`enrich`, `match`, `cluster`, `suggest`); credential checks, evaluations and model probes never feed them (D-272).

`house.alerts` also records resolved transitions and sends one recovery notification per active
incident. Mail transport failure leaves the notification pending; mark `lastSentAt` only after SMTP
acceptance. Bound and redact details, retry with backoff, and keep reporting failures measurable.
A retry may duplicate an email after an uncertain SMTP acknowledgment; do not promise exactly once.

`house.alerts` keeps its state in `settings['alerts.state']` (`{[alertKey]: {firstAt, lastSentAt, active, title?}}`; the `title` of the alert is stored on each run the condition holds). A recovery notification lists each cleared incident by its stored title (the key for an entry stored without one) and its UTC first-seen time (D-203).
It sends through the shared mailer (`packages/shared/src/mail/`, which uses `SMTP_URL`, `MAIL_FROM` and
`MAIL_TRANSPORT`). The worker therefore needs the mail settings too (spec 01 §3).

| Alert | Condition |
|---|---|
| Classification engine failing (key `engine.breaker`) | `settings['engine.circuit'].typesafe` is `open` or `half_open` and its failing streak (`failingSince`, else `openedAt`) is more than 30 min old; or it is `auth` (immediately, titled "Engine credentials rejected"); or, with the breaker closed or absent, at least 3 distinct TypeSafe classification requests failed and none succeeded in the last 30 min (the breaker trips only at 20 requests in 5 min in one process). The mail names the streak or the failure count, the last failure, the configured and the pinned model (D-272) |
| Jev answered with another model (key `engine.model_mismatch`) | a TypeSafe classification call failed `invalid_response` with detail `model_mismatch:<answered id>` in the last 45 min (longer than the 30 min between probes of a flapping breaker, so the incident does not clear and re-fire at each probe); the mail names up to 3 requested/answered pairs with counts (D-272) |
| Budget | `settings['engine.budget_alerts']` has `p80At` or `p100At` for today (spec 04 §6) |
| Pipeline backlog | any queue > 5,000 due waiting jobs, oldest due job > 30 min, pending outbox > 5 min, or rising terminal failures (≥ 20 pg-boss jobs failed for good in the last hour and ≥ 3× the hourly mean of the 24 h before); intentional future cooldown jobs are excluded |
| Service health | no worker heartbeat for 30 min, a housekeeping job whose `house.progress.updatedAt` is older than 2 of its cron periods (or that has no entry once a worker consuming it has been up longer than 2 periods, D-191), or LibreTranslate unreachable while a language mode is `translate` or `card_text_mode` is `english`. Also: clients waiting for a worker database connection (`pool.waiting > 0` in the heartbeat) on 3 consecutive `house.alerts` runs; a container with ≥ 3 restarts within 60 min or an OOM kill, from the `containers` field of the `host_health` report; and (from M9) `worker-laya` while `engine.laya` lists a language or Laya work is outstanding (§2). External readiness failure and full-host failure are the owner's external monitor's (D-177) |
| Degraded share | at least 20 new articles in the last hour and more than 20 % of them degraded |
| Feed failures | at least 5 subscribed `active`/`quarantined` feeds and more than 10 % of them with an error in the last 24 h |
| Disk | filesystem containing Postgres or backup staging > 80 % full, < 10 GB free, or inode exhaustion; host script (cron, every 15 min) reports structured `host_health` capacity/heartbeat events via the bounded ops-event channel, without mounting PGDATA into an app container; no `host_health` event for over 1 h is itself an alert |
| Backups | the backup script or the restore test reported failure through `POST /api/v1/admin/ops-event` (the latest `backup_failed`, `restore_ok` and `restore_failed` times are remembered in `alerts.state` like `backup_ok`, so a failure that left the 50-entry `ops.events` stays open until a newer success, D-191) (stored in `settings['ops.events']`), or no `backup_ok` event in the last 26 h (the latest `backup_ok` time is also kept in `alerts.state` so it outlives the 50-event `ops.events` list) |
| Metrics | `for_you` like-rate below `maybe` like-rate with the 95 % Newcombe-Wilson interval of the difference entirely below 0 on 3 consecutive daily snapshots, each judged on its trailing 7-day lanes with at least 30 rated items in both (spec 10 §7) |

---

## 7. Security checklist (verified in M8-T6)

- **TLS:** Caddy-managed certificates with HSTS (`max-age=31536000`).
- **Headers** set by Caddy:
  - CSP: `default-src 'self'; img-src 'self' https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- **Third-party images:** default blocked; do not create remote `src`/CSS URLs (including feed icons)
  until the user explicitly allows them. Remember an “always allow images from this feed” choice
  per user+feed; it neither enables images for another user nor becomes a global feed property.
  Apply the canonical media-policy precedence and bookmark-origin rules in specs08/09, including
  remembered choice after unsubscribe. Explain that loading discloses IP/request
  metadata to the publisher. Opted-in images use `referrerpolicy="no-referrer"` and `loading="lazy"`,
  HTTPS only, with local placeholders; no-referrer alone is not tracking protection. An authenticated,
  SSRF-safe image proxy is a separate future feature. Login/privacy pages load no third-party media.
- **Session cookie and CSRF:** spec 08 §1–2.
- **Rate limits:** spec 08 §11.
- **SSRF-safe fetcher:** spec 03 §4, with the test suite covering every blocked range and redirects
  into private space.
- **HTML handling:** all third-party HTML is sanitized (spec 03 §6.3). The web client never uses
  `dangerouslySetInnerHTML` except with sanitized fields, and those are sanitized **again** client-side
  with DOMPurify.
- **Database:**
  - the API uses the `bantoozi_app` role (RLS)
  - the worker's BYPASSRLS role is never used by the API
  - the RLS isolation suite passes (spec 08 §12)
- **Logs:** no secrets, codes, tokens, raw URL queries, provider prompt/response text, login/email
  bodies or exported user data. Redact `Authorization`, cookies and SMTP/DB URLs centrally. Record
  correlation IDs, entity IDs, model/version hashes and bounded error codes; hash/omit user emails.
- **Dependencies:** `pnpm audit --prod` in CI (high/critical fail the build) and Renovate weekly.
- **Model input:** article text sent to Jev and Ollama is public content. Card texts and example titles
  are personal. Document this in the privacy page (`/privacy`, a static page linked from login).

---

## 8. Model and question-set upgrades

1. Run `eval replay` with the new `TYPESAFE_MODEL`, question set, Laya checkpoint or calibration
   or, while `LLM_FALLBACK_ENABLED`, Ollama fallback models (spec 10 §6). It must pass.
2. Set the value in **Admin → Settings** (`engine.typesafe_model`, `engine.llm_fallback_enabled`,
   `engine.ollama_models`; spec 08 §9 requires the acknowledgement that step 1 passed) or in the env
   file. A settings change needs no manual restart: each worker notices the changed restart-class value
   (it re-reads the settings every 10 s), drains and exits, and compose restarts it (`WORKER_SELF_RESTART`,
   default true in production, spec 01 §3); with `false` the worker only warns and reports
   `pendingRestart`, and the operator restarts it. An env change still needs `up -d --force-recreate`.
3. New answers carry the new model id. Old answers no longer satisfy current cache lookups (spec 02
   §3.3). The first worker that starts with a new `TYPESAFE_MODEL` or a different LLM fallback
   state (`LLM_FALLBACK_ENABLED` switched either way, or a new `OLLAMA_MODEL_FAST`/
   `OLLAMA_MODEL_STRONG` while it is on) records them in `settings['engine.model_pin']`, whose `llm`
   field exists only while the fallback is on. Under a row lock it enqueues `house.reenrich` and
   `house.rematch` once, so the `RANK_WINDOW_DAYS` window is rebuilt within budget (spec 05 §2), in
   bulk priority and never through the fallback (owner decision, D-171); if Jev is unavailable the
   runs wait as pending runs for `house.reconcile`. `pnpm db:seed` inserts the row when missing
   without a rebuild. The pin is derived from the **effective** values (stored setting over env, D-221), so
   the rebuild runs exactly once whichever worker restarts first. **Stale-worker guard:** between a restart-class value
   or the pin moving and a worker restarting, that worker fails `article.enrich`, `article.match`,
   `house.reenrich`, `house.rematch` and `card.backfill` with a retry delay of 30 s instead of asking the old
   model or writing its answers; the retry lands on a restarted worker. A worker is stale when the restart
   fingerprint of the **current** effective settings (one fresh read per job, the condition behind
   `pendingRestart`) differs from the one it booted with, or when `engine.model_pin` names another model or
   another fallback state and Ollama model pair than the process records (D-218, D-225). The check also runs in the
   completion transaction, after share-locking the restart-class setting rows and the pin row: a value that moved while
   the model call was in flight discards the answer, releases the held rows and fails the job for the 30 s retry (D-226).
   **Which handlers are guarded (D-228):** guarded at the start and in the completion are every handler that asks
   the engine or a translator and stores a result classification reads: `article.enrich`, `article.match`,
   `article.cluster` (the fold decision), `article.translate` (tier-1/tier-2 rows), `house.translate-cards` (the English
   card pair), `house.reenrich`, `house.rematch` and `card.backfill`. Deliberately unguarded: `analysis.process`
   (user-requested, records its own model snapshot), `user.suggest` (checks the pin itself and leases per user),
   `provider.validate` (probes a candidate key; stores no classification result), and the dispatch-only recovery
   jobs `house.rescore-degraded`, `house.reconcile` and `house.retranslate-skipped` (they enqueue work that is
   itself guarded).
   Translation rows are not rebuilt: they stay valid for their article revision whatever model made
   them (spec 07 §3), so re-enrichment reuses the selected translation. In M9 the Laya worker records
   its checkpoint hash and calibration version the same way and enqueues `house.reenrich {lang}`
   once for each language in `engine.laya` (spec 04 §9).
4. Verify whether feature meanings and answer vocabulary remain compatible. If `feature_spec_sha`
   changes, deactivate incompatible user models and rerank with cards/degraded scoring until retrained;
   a stable feature name alone does not establish compatible semantics. Publish the new active set
   and its outbox work atomically; in-flight old-set answers cannot become active after the switch.
5. A new **enrich** question set triggers `house.reenrich` for still-authorized demand whose carrier
   arrival is within the 14-day `RANK_WINDOW_DAYS`, within budget. New model availability never implicitly enables an untrained feed.

---

## 9. Launch checklist (invite-only beta, end of M8)

- [ ] All milestones through M8 are done. G1 decisions are applied in production settings.
- [ ] G1 has an `owner_pilot` or `multi_person_beta` PASS under spec 10 (accepted Q13). A passing
      owner-only pilot is sufficient for this initial beta; additional raters are not a prerequisite. All existing
      quality, cost, security, operational and recovery gates still pass.
- [ ] `TYPESAFE_MODEL` is pinned. The daily budget is set from the G1 recommendation.
- [ ] Off-site encrypted backups and offline keys restore successfully, including roles/RLS,
      deletion-ledger replay and queue recovery; measured RPO/RTO accepted. Every alert and recovery
      transition fired in a drill, including a stopped worker and an unreachable host.
- [ ] The admin account exists. 10 invites were created for testers. The waitlist form works.
- [ ] Starter bundles verified (every feed fetches, languages are correct).
- [ ] Privacy page describes providers, remote images, deletion grace, backup expiry, invite and
      waitlist retention, and export;
      contact and `/bot` page published. SMTP SPF/DKIM/DMARC and delivered login mail verified.
- [ ] Load sanity (M8-T8): 20 simulated users × 50 feeds × 10 cards for 1 hour.
      - **Setup:** a generated fixture feed server (1,000 feeds on 50 ports, each listing its newest
        3 items and publishing 5 new ones per hour, from `packages/testing`) and the fake TypeSafe
        server with `latencyMs: 300` (`TYPESAFE_MODEL=jev-fake`). User `n` subscribes to 50 feeds
        from `30n` and adopts 10 library cards from `4n`, so neighbours share 20 feeds and 6 cards.
        `load:run` runs four phases (20/30/30/20 % of the time): all off, selected-article training,
        automatic inference on a few feeds, and a failing provider (D-183). The **gate is the
        `realistic` profile** (default): each user lists at page load, then polls the list every 5 s
        while `rankingPending` and the counts every 30 s when idle (spec 09 §3), opens or rates
        one article every 10–20 s and makes a navigation list every 30–60 s; p95 needs at least 300
        list samples per phase. The `stress` profile (1 list/s and 1 open-or-rate/s per user) is
        reported, not gated (D-187). The API runs with
        `NODE_ENV=test`, `RATE_LIMITS_ENABLED=false` and `FETCH_ALLOW_PRIVATE=true` in a separate test
      Compose project/DB; never relax production config. Per-user schedulers (realistic) or `autocannon` (stress) simulate list/counts/open/rate traffic.
      - **On the target box:** CPU < 70 %, p95 `GET /articles` < 300 ms, no queue-backlog alert.
      - **On a local production-like stack** (when there is no host access): the same p95 and backlog
        criteria. CPU is reported but not gated.


- [ ] Deploy/rollback drill preserves live reader state; full host reboot starts healthy dependencies,
      catches up missed cron work and drains old outbox intents without duplicate side effects.
- [ ] Two workers pass concurrent ingestion, merge, revision, quota, budget and origin-throttle tests;
      load test uses the actual configured pool/memory budget, and at least one high-latency/failing
      provider scenario proves degraded reading stays available. The load feeds list the newest 4 items
      (the bound at the converged 900 s interval and 5 items/h) and the load report records each
      container's `RestartCount` (D-205).
- [ ] Production DNS/TLS, system time synchronization, external uptime/backup monitor, alert recipient,
      release owner, incident contact and the maintenance/restore instructions are recorded.
- [ ] Fresh-instance bootstrap and upgrade from the previous schema both pass migration/seed tests;
      runtime images contain required CLIs/artifacts and no service has another role's credentials.

- [ ] User-selected training infers only selected articles, active feeds infer new arrivals, and
      all-off feeds run ingestion/reading/bookmark capture with zero article-provider calls.
- [ ] A bookmarked article's full available text/HTML survives source deletion, cold maintenance,
      unsubscribe and backup restore; export checksum matches, and failed/partial capture is honest.
- [ ] Per-user-feed image opt-in survives reload/unsubscribe without changing another user's policy;
      archived content never fetches remote media automatically just because it was previously saved.
