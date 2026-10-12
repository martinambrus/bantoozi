import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const read = (path: string): string => readFileSync(`${root}${path}`, 'utf8');
const scripts = ['infra/scripts/backup.sh', 'infra/scripts/restore-test.sh'] as const;
const hostScripts = [
  'infra/scripts/deploy.sh',
  'infra/scripts/maintenance.sh',
  'infra/scripts/host-health.sh',
] as const;
const compose = read('infra/compose.yml');

describe('backup and restore scripts (static checks)', () => {
  it.each(scripts)('%s is strict and shell-clean', (path) => {
    const text = read(path);
    expect(text).toContain('set -euo pipefail');
    expect(text).not.toMatch(/:latest/u);
    expect(text).not.toMatch(/\bcurl\b|\bwget\b/u);
    // A password only ever travels by environment name (`-e PGPASSWORD`), never as a value in argv.
    expect(text).not.toMatch(/--password|--token|-e PGPASSWORD=/u);
    expect(text.replaceAll(/PGPASSWORD="\$2" docker exec -e PGPASSWORD /gu, '')).not.toMatch(
      /PGPASSWORD/u,
    );
  });

  it('hands secrets to containers by name only', () => {
    const lib = read('infra/scripts/ops-lib.sh');
    const restore = read('infra/scripts/restore-test.sh');
    for (const text of [lib, restore]) {
      for (const [, name] of text.matchAll(/ -e ([A-Z0-9_]+)(=\S*)?/gu)) expect(name).toBeDefined();
      // Only non-secret settings may be set inline.
      for (const [, name] of text.matchAll(/ -e ([A-Z0-9_]+)=/gu))
        expect(name).toBe('POSTGRES_HOST_AUTH_METHOD');
    }
    expect(lib).toContain('-e S3_SECRET_KEY');
  });

  it('uses the same postgres image as the compose stack, pinned by digest', () => {
    const lib = read('infra/scripts/ops-lib.sh');
    const pinned = /POSTGRES_IMAGE="(postgres:16@sha256:[0-9a-f]{64})"/u.exec(lib)?.[1];
    expect(pinned).toBeDefined();
    expect(compose).toContain(`image: ${pinned}`);
  });

  it('starts the throwaway postgres without any network and without published ports', () => {
    const restore = read('infra/scripts/restore-test.sh');
    expect(restore).toMatch(/--network none/u);
    expect(restore).not.toMatch(/ -p [0-9]|--publish/u);
    expect(restore).toMatch(/docker rm -f -v "\$PG_NAME"/u);
    expect(restore).toContain('--exit-on-error');
    expect(restore).toContain('ON_ERROR_STOP=1');
  });

  it('dumps with a superuser PostgreSQL 16 client and writes the manifest last', () => {
    const backup = read('infra/scripts/backup.sh');
    expect(backup).toContain('pg_dump -U postgres -Fc bantoozi');
    expect(backup).toContain('pg_dumpall -U postgres --globals-only --no-role-passwords');
    expect(backup.indexOf('backup:put "${P}dump.age"')).toBeLessThan(
      backup.indexOf('backup:put "${P}manifest.age"'),
    );
    expect(backup.indexOf('backup:put "${P}globals.age"')).toBeLessThan(
      backup.indexOf('backup:put "${P}manifest.age"'),
    );
    expect(backup.indexOf('backup:put "${P}manifest.age"')).toBeLessThan(
      backup.lastIndexOf('backup:prune'),
    );
    expect(backup).toContain('flock -n 9');
  });

  it('ships and verifies the deletion ledger before the manifest, the final commit point', () => {
    const backup = read('infra/scripts/backup.sh');
    const ledger = backup.indexOf('backup:put-raw "${BACKUP_S3_LEDGER_PREFIX}');
    expect(ledger).toBeGreaterThan(-1);
    expect(ledger).toBeLessThan(backup.indexOf('backup:put "${P}manifest.age"'));
    expect(backup.indexOf('STAGE=ledger')).toBeLessThan(backup.indexOf('STAGE=manifest'));
  });

  it('holds the erasure advisory lock from before pg_dump until the ledger is shipped, released in the trap (R3)', async () => {
    const backup = read('infra/scripts/backup.sh');
    const shared = await import('@bantoozi/shared');
    expect(backup).toContain(`ERASURE_BACKUP_LOCK_KEY=${shared.ERASURE_BACKUP_LOCK_KEY}`);
    expect(String(shared.ERASURE_BACKUP_LOCK_KEY)).toMatch(/^\d+$/u);
    const acquire = backup.indexOf('pg_advisory_lock(');
    expect(acquire).toBeGreaterThan(-1);
    expect(backup).toContain('lock_timeout');
    expect(backup.indexOf('STAGE=erasure-lock')).toBeGreaterThan(-1);
    expect(acquire).toBeLessThan(backup.indexOf('pg_dump -U postgres'));
    const ledgerShip = backup.indexOf('backup:put-raw "${BACKUP_S3_LEDGER_PREFIX}');
    const manifestPut = backup.indexOf('backup:put "${P}manifest.age"');
    const release = backup.indexOf('release_erasure_lock\n', backup.indexOf('STAGE=ledger'));
    expect(release).toBeGreaterThan(ledgerShip);
    // R4: the lock outlives the verified manifest upload (the commit point) and is released right after.
    expect(release).toBeGreaterThan(manifestPut);
    expect(release).toBeLessThan(backup.lastIndexOf('STAGE=prune'));
    const trap = backup.slice(backup.indexOf('on_exit() {'), backup.indexOf('trap on_exit EXIT'));
    expect(trap).toContain('release_erasure_lock');
  });

  it('keeps the writer and the retention credentials apart', () => {
    const backup = read('infra/scripts/backup.sh');
    expect(backup).toMatch(/writer\(\) \{ S3_ACCESS_KEY="\$WRITER_AK"/u);
    expect(backup).toMatch(/pruner\(\) \{ S3_ACCESS_KEY="\$PRUNE_AK"/u);
    expect(backup).not.toMatch(/writer tools_run backup:prune/u);
  });

  it('posts ops-events through the api container with the token read there', () => {
    const lib = read('infra/scripts/ops-lib.sh');
    expect(lib).toContain('dc exec -T api node -e');
    expect(lib).toContain('process.env.METRICS_TOKEN');
    expect(lib).not.toMatch(/METRICS_TOKEN="?\$/u);
  });
});

describe('deploy, maintenance and host-health scripts (static checks)', () => {
  it.each(hostScripts)('%s is strict', (path) => {
    expect(read(path)).toContain('set -euo pipefail');
  });

  it('documents the host-health cron line and keeps the token out of arguments and output', () => {
    const text = read('infra/scripts/host-health.sh');
    expect(text).toMatch(/^# {3}\*\/15 \* \* \* \* \S*host-health\.sh --env-file /mu);
    expect(text).toContain('process.env.METRICS_TOKEN');
    expect(text).not.toMatch(/METRICS_TOKEN="?\$|envfile_get METRICS_TOKEN/u);
    expect(text).toContain('kind: "host_health"');
  });

  it('serves a 503 page with Retry-After from a flag file in the caddy data volume', () => {
    const caddyfile = read('infra/caddy/Caddyfile');
    expect(caddyfile).toContain('root /data/maintenance');
    expect(caddyfile).toMatch(/not path \/api\/v1\/readyz/u);
    expect(caddyfile).toMatch(/header Retry-After "\d+"/u);
    expect(caddyfile).toMatch(/^\s*HTML 503$/mu);
    expect(compose).toContain('- caddy-data:/data');
    expect(read('infra/scripts/maintenance.sh')).toContain('FLAG_DIR=/data/maintenance');
  });

  it('requires the deletion ledger variables in the preflight, before any backup or migration (R4)', () => {
    const deploy = read('infra/scripts/deploy.sh');
    const required = deploy.slice(deploy.indexOf('REQUIRED=('), deploy.indexOf('missing=()'));
    for (const v of ['DELETION_LEDGER_PATH', 'DELETION_LEDGER_RECIPIENT', 'DELETION_HMAC_KEY']) {
      expect(required).toContain(v);
    }
    expect(deploy.indexOf('REQUIRED=(')).toBeLessThan(deploy.indexOf('backup.sh'));
  });

  it('gates the deploy on stored settings and turns maintenance on when compatibility is not shown', () => {
    const deploy = read('infra/scripts/deploy.sh');
    for (const check of [
      'language_modes',
      'card_text_mode',
      'engine.laya',
      'Laya work is outstanding',
    ]) {
      expect(deploy).toContain(check);
    }
    expect(deploy.indexOf('Laya work is outstanding')).toBeLessThan(deploy.indexOf('step "build'));
    expect(deploy).toContain('smoke: outbox dispatch ok');
    expect(deploy).toContain('smoke: queue traversal ok');
    expect(deploy).toMatch(/pre-deploy backup skipped: fresh instance/u);
    expect(deploy).toMatch(/"\$MAINTENANCE" --env-file "\$ENV_FILE" on/u);
  });

  it('pre-creates the smoke account in the throwaway database before the release starts', () => {
    const restore = read('infra/scripts/restore-test.sh');
    // A restored settings.signup_mode = 'closed' beats the SIGNUP_MODE of the smoke environment, so
    // the smoke address must already exist: an existing user always gets a login code.
    const insert = restore.indexOf('insert into users');
    expect(insert).toBeGreaterThan(-1);
    const step = restore.slice(insert - 400, insert + 400);
    expect(step).toContain('"$PG_NAME"');
    expect(step).toContain('$SMOKE_EMAIL');
    expect(step).toContain('on conflict (email) do nothing');
    expect(insert).toBeLessThan(restore.indexOf('release_start "$API_NAME"'));
    expect(restore).not.toMatch(/update settings|insert into settings/iu);
  });

  it('sets the role passwords after the restore and proves each role logs in over scram TCP', () => {
    const restore = read('infra/scripts/restore-test.sh');
    const stage = restore.indexOf('STAGE=role-passwords');
    expect(stage).toBeGreaterThan(restore.indexOf('recovery:prepare </dev/null'));
    expect(stage).toBeLessThan(restore.indexOf('STAGE=release-smoke'));
    const body = restore.slice(stage, restore.indexOf('STAGE=release-smoke'));
    expect(body).toContain('recovery:role-passwords');
    expect(body).toContain('scram-sha-256');
    expect(body).toMatch(/-h 127\.0\.0\.1 -U "\$1"/u);
    for (const role of ['bantoozi_owner', 'bantoozi_app', 'bantoozi_worker']) {
      expect(body).toContain(role);
    }
    // Passwords travel by environment name, never on a command line.
    expect(restore).toContain(
      '-e BANTOOZI_OWNER_PASSWORD -e BANTOOZI_APP_PASSWORD -e BANTOOZI_WORKER_PASSWORD',
    );
    expect(restore).not.toContain('release-smoke@localhost');
    expect(restore).toContain('echo "ROLE_LOGINS tcp_scram=$ROLE_LOGINS"');
  });

  it('starts the saved release without any network and reports the four smoke results', () => {
    const restore = read('infra/scripts/restore-test.sh');
    expect(restore).toContain(
      'RELEASE_SMOKE login=$SMOKE_LOGIN read=$SMOKE_READ rank=$SMOKE_RANK outbox=$SMOKE_OUTBOX',
    );
    expect(restore).toContain('recovery:prepare');
    const start = restore.slice(
      restore.indexOf('release_start()'),
      restore.indexOf('API_NAME="$(uniq_name'),
    );
    expect(start).toContain('--network none');
    expect(start).toContain('--read-only');
    expect(start).toContain('--cap-drop ALL');
    expect(start).not.toMatch(/ -p [0-9]|--publish|--privileged/u);
    expect(start).not.toMatch(/ -e [A-Z0-9_]+=/u);
    expect(restore).toMatch(/docker rm -f -v "\$WORKER_NAME" "\$API_NAME"/u);
  });
});

describe('compose stack for the backup tooling', () => {
  it('has a digest-pinned minio in the rehearsal profile with no published ports', () => {
    const block =
      /\n {2}minio:\n([\s\S]*?)\n {2}[a-z-]+:\n|\n {2}minio:\n([\s\S]*?)\nvolumes:/u.exec(compose);
    const text = block?.[1] ?? block?.[2] ?? '';
    expect(text).toContain(
      'image: minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e',
    );
    expect(text).toContain('profiles: [rehearsal]');
    expect(text).not.toMatch(/\n {4}ports:/u);
  });

  it('mounts a persistent ledger volume on the worker and the env examples point at it', () => {
    expect(compose).toContain('- ledger:/var/lib/bantoozi/ledger');
    expect(compose).toMatch(/\nvolumes:\n(?: {2}.*\n)* {2}ledger:/u);
    for (const file of ['infra/env/prod.example.env', 'infra/env/local-rehearsal.env.example']) {
      const text = read(file);
      expect(text).toContain('DELETION_LEDGER_PATH=/var/lib/bantoozi/ledger/deletion-ledger.age');
      for (const key of [
        'BACKUP_S3_ENDPOINT',
        'BACKUP_S3_BUCKET',
        'BACKUP_S3_ACCESS_KEY',
        'BACKUP_S3_PRUNE_SECRET_KEY',
        'BACKUP_AGE_RECIPIENT',
      ]) {
        expect(text).toMatch(new RegExp(`^${key}=`, 'mu'));
      }
    }
  });

  it('builds the tools image from a Dockerfile target and has no plaintext secret defaults', () => {
    const dockerfile = read('infra/docker/Dockerfile');
    expect(dockerfile).toContain('AS backup-tools');
    expect(dockerfile).toContain('chown -R 1000:1000 /var/lib/bantoozi');
    for (const file of ['infra/env/prod.example.env', 'infra/env/local-rehearsal.env.example']) {
      expect(read(file)).toMatch(/^BACKUP_S3_SECRET_KEY=$/mu);
    }
  });
});

describe('deploy refuses the laya profile until M9', () => {
  it('stops before any backup or migration when COMPOSE_PROFILES includes laya', () => {
    const script = read('infra/scripts/deploy.sh');
    const gate = script.indexOf('has_profile laya && die');
    expect(gate).toBeGreaterThan(-1);
    expect(script.slice(gate, gate + 300)).toMatch(/M9/u);
    expect(gate).toBeLessThan(script.indexOf('step "pre-deploy backup"'));
    expect(gate).toBeLessThan(script.indexOf('step "migrate'));
  });
});

describe('deploy connection budget', () => {
  const budget = (profiles: string): number =>
    Number(
      execFileSync(
        'bash',
        [
          '-c',
          `source "${root}infra/scripts/ops-lib.sh"; PROFILES=(${profiles}); has_profile() { local p; for p in "\${PROFILES[@]}"; do [ "$p" = "$1" ] && return 0; done; return 1; }; connection_budget`,
        ],
        { encoding: 'utf8' },
      ).trim(),
    );

  it.each([
    ['', 54],
    ['laya', 64],
    ['translate laya', 64],
  ])('profiles [%s] need %i connections, below the 80 allowed', (profiles, expected) => {
    const value = budget(profiles);
    expect(value).toBe(expected);
    expect(value).toBeLessThan(80);
  });
});
