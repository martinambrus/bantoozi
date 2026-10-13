import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { ProviderKeyring } from '@bantoozi/shared/server/credential-crypto';
import { identityToRecipient } from 'age-encryption';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Each CLI spawn starts tsx (about 2 s locally, far more on a cold CI runner under coverage).
vi.setConfig({ testTimeout: 120_000 });

// M8b-T8: `pnpm setup:env` (apps/ops env:init, scope A4). Runs the real CLI in a child process on
// temp directories; no network, no database.

const OPS_DIR = resolve(import.meta.dirname, '..');
const TSX = join(OPS_DIR, 'node_modules/.bin/tsx');

const TEMPLATE = `# template
NODE_ENV=development
POSTGRES_PASSWORD=postgres
BANTOOZI_OWNER_PASSWORD=bantoozi_owner
BANTOOZI_APP_PASSWORD=bantoozi_app
BANTOOZI_WORKER_PASSWORD=bantoozi_worker
SESSION_PEPPER=change-me-to-a-long-random-string
METRICS_TOKEN=change-me
PROVIDER_MASTER_KEY_ID=
PROVIDER_MASTER_KEYS=
DELETION_LEDGER_PATH=
DELETION_LEDGER_RECIPIENT=
DELETION_HMAC_KEY=
LOG_LEVEL=info
`;

const SECRET_NAMES = [
  'SESSION_PEPPER',
  'METRICS_TOKEN',
  'PROVIDER_MASTER_KEY_ID',
  'PROVIDER_MASTER_KEYS',
  'DELETION_HMAC_KEY',
  'DELETION_LEDGER_RECIPIENT',
];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bantoozi-t8-'));
  writeFileSync(join(dir, 'template.env'), TEMPLATE);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(args: string[] = [], envFile = join(dir, '.env')) {
  const result = spawnSync(
    TSX,
    [
      '--conditions=bantoozi-source',
      join(OPS_DIR, 'src/cli.ts'),
      'env:init',
      '--file',
      envFile,
      '--template',
      join(dir, 'template.env'),
      ...args,
    ],
    { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: dir } },
  );
  return {
    status: result.status,
    out: `${result.stdout}\n${result.stderr}`,
    stdout: result.stdout,
  };
}

function parseEnv(text: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/u.exec(line);
    if (m?.[1] !== undefined) map[m[1]] = m[2] ?? '';
  }
  return map;
}
const read = (file = join(dir, '.env')) => readFileSync(file, 'utf8');
const vars = (file = join(dir, '.env')) => parseEnv(read(file));
const mode = (file: string) => statSync(file).mode & 0o777;

function listFiles(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) found.push(join(entry.parentPath, entry.name));
  }
  return found;
}

describe('env:init (M8b-T8)', () => {
  it('creates the env file from the template with every secret filled', () => {
    const r = run();
    expect(r.status).toBe(0);
    const v = vars();
    expect(v.LOG_LEVEL).toBe('info');
    expect(v.SESSION_PEPPER!.length).toBeGreaterThanOrEqual(32);
    expect(v.SESSION_PEPPER).not.toMatch(/^change-me/u);
    expect(v.METRICS_TOKEN!.length).toBeGreaterThanOrEqual(32);
    expect(v.METRICS_TOKEN).not.toBe(v.SESSION_PEPPER);
    expect(v.DELETION_HMAC_KEY).toMatch(/^[0-9a-f]{64}$/u);
    expect(v.PROVIDER_MASTER_KEY_ID).toMatch(/^k\d{8}/u);
    expect(v.DELETION_LEDGER_RECIPIENT).toMatch(/^age1[a-z0-9]+$/u);
    expect(v.DELETION_LEDGER_PATH).not.toBe('');
  });

  it('fills only empty or placeholder secrets and never overwrites a real value', () => {
    writeFileSync(
      join(dir, '.env'),
      TEMPLATE.replace(
        'SESSION_PEPPER=change-me-to-a-long-random-string',
        'SESSION_PEPPER=my-real-pepper-value-0123456789abcdef',
      ),
    );
    const r = run();
    expect(r.status).toBe(0);
    const v = vars();
    expect(v.SESSION_PEPPER).toBe('my-real-pepper-value-0123456789abcdef');
    expect(v.METRICS_TOKEN).not.toBe('change-me');
    expect(v.DELETION_HMAC_KEY).not.toBe('');
  });

  it('a second run changes nothing (byte-equal, including the files beside it)', () => {
    run();
    const first = read();
    const files = listFiles(dir).sort();
    const contents = files.map((f) => readFileSync(f).toString('base64'));
    const r = run();
    expect(r.status).toBe(0);
    expect(read()).toBe(first);
    expect(listFiles(dir).sort()).toEqual(files);
    expect(
      listFiles(dir)
        .sort()
        .map((f) => readFileSync(f).toString('base64')),
    ).toEqual(contents);
  });

  it('writes the env file with mode 0600, also when it existed with a wider mode', () => {
    run();
    expect(mode(join(dir, '.env'))).toBe(0o600);
    rmSync(join(dir, '.env'));
    writeFileSync(join(dir, '.env'), TEMPLATE);
    chmodSync(join(dir, '.env'), 0o644);
    run();
    expect(mode(join(dir, '.env'))).toBe(0o600);
  });

  it('refuses a symlinked target and leaves the link target untouched', () => {
    const real = join(dir, 'real.env');
    writeFileSync(real, TEMPLATE);
    symlinkSync(real, join(dir, '.env'));
    const r = run();
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/symlink|symbolic/iu);
    expect(readFileSync(real, 'utf8')).toBe(TEMPLATE);
  });

  it('prints names but none of the generated values, and no value lands in stdout or stderr', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.out).toContain('PROVIDER_MASTER_KEYS');
    expect(r.out).toMatch(/restart/iu);
    const v = vars();
    const keys = JSON.parse(v.PROVIDER_MASTER_KEYS!) as Record<string, string>;
    const secrets = [
      v.SESSION_PEPPER,
      v.METRICS_TOKEN,
      v.DELETION_HMAC_KEY,
      ...Object.values(keys),
      readFileSync(identityFile(), 'utf8').trim().split('\n').pop(),
    ];
    for (const secret of secrets) {
      expect(secret!.length).toBeGreaterThan(20);
      expect(r.out).not.toContain(secret);
    }
  });

  it('generates a keyring that ProviderKeyring.parse accepts, with the active key id', () => {
    run();
    const v = vars();
    const parsed = ProviderKeyring.parse(v.PROVIDER_MASTER_KEY_ID, v.PROVIDER_MASTER_KEYS);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.keyring.activeKeyId).toBe(v.PROVIDER_MASTER_KEY_ID);
      expect(parsed.keyring.keyIds).toEqual([v.PROVIDER_MASTER_KEY_ID]);
    }
  });

  it('writes a dev ledger identity to a separate 0600 file whose recipient matches', async () => {
    run();
    const v = vars();
    const file = identityFile();
    expect(file).not.toBe(join(dir, '.env'));
    expect(mode(file)).toBe(0o600);
    const identity = readFileSync(file, 'utf8').match(/AGE-SECRET-KEY-[A-Z0-9]+/u)?.[0];
    expect(identity).toBeDefined();
    expect(await identityToRecipient(identity!)).toBe(v.DELETION_LEDGER_RECIPIENT);
    // The identity never enters the env file and the ledger path sits under .data/.
    expect(read()).not.toContain('AGE-SECRET-KEY');
    expect(v.DELETION_LEDGER_PATH).toMatch(/(^|\/)\.data\//u);
  });

  it('does not generate a ledger identity when a recipient is already configured', () => {
    const recipient = 'age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
    writeFileSync(
      join(dir, '.env'),
      TEMPLATE.replace('DELETION_LEDGER_RECIPIENT=', `DELETION_LEDGER_RECIPIENT=${recipient}`),
    );
    expect(run().status).toBe(0);
    expect(vars().DELETION_LEDGER_RECIPIENT).toBe(recipient);
    expect(listFiles(dir).some((f) => /AGE-SECRET-KEY/u.test(readFileSync(f, 'utf8')))).toBe(false);
  });

  it('--add-provider-key keeps the old key ids and values and switches the active id', () => {
    const oldKey = randomBytes(32).toString('base64');
    writeFileSync(
      join(dir, '.env'),
      TEMPLATE.replace('PROVIDER_MASTER_KEY_ID=', 'PROVIDER_MASTER_KEY_ID=k20200101').replace(
        'PROVIDER_MASTER_KEYS=',
        `PROVIDER_MASTER_KEYS={"k20200101":"${oldKey}"}`,
      ),
    );
    const r = run(['--add-provider-key']);
    expect(r.status).toBe(0);
    const v = vars();
    expect(v.PROVIDER_MASTER_KEY_ID).not.toBe('k20200101');
    const keys = JSON.parse(v.PROVIDER_MASTER_KEYS!) as Record<string, string>;
    expect(Object.keys(keys)).toHaveLength(2);
    expect(keys.k20200101).toBe(oldKey);
    const parsed = ProviderKeyring.parse(v.PROVIDER_MASTER_KEY_ID, v.PROVIDER_MASTER_KEYS);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.keyring.activeKeyId).toBe(v.PROVIDER_MASTER_KEY_ID);
    expect(r.out).not.toContain(keys[v.PROVIDER_MASTER_KEY_ID!]!);
    // Adding again on the same day still yields a fresh id.
    run(['--add-provider-key']);
    const again = JSON.parse(vars().PROVIDER_MASTER_KEYS!) as Record<string, string>;
    expect(Object.keys(again)).toHaveLength(3);
    expect(again.k20200101).toBe(oldKey);
  });

  it('a plain run never rotates an existing keyring', () => {
    run();
    const before = vars();
    run();
    expect(vars().PROVIDER_MASTER_KEYS).toBe(before.PROVIDER_MASTER_KEYS);
    expect(vars().PROVIDER_MASTER_KEY_ID).toBe(before.PROVIDER_MASTER_KEY_ID);
  });

  it('--production refuses to generate the ledger identity and prints age-keygen instructions', () => {
    const r = run(['--production']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('age-keygen');
    expect(vars().DELETION_LEDGER_RECIPIENT).toBe('');
    expect(listFiles(dir).some((f) => /AGE-SECRET-KEY/u.test(readFileSync(f, 'utf8')))).toBe(false);
    // The other secrets are still filled.
    expect(vars().SESSION_PEPPER).not.toMatch(/^change-me/u);
    expect(
      ProviderKeyring.parse(vars().PROVIDER_MASTER_KEY_ID, vars().PROVIDER_MASTER_KEYS).ok,
    ).toBe(true);
  });

  it('--production fills empty role passwords but leaves set ones', () => {
    writeFileSync(
      join(dir, '.env'),
      TEMPLATE.replace('POSTGRES_PASSWORD=postgres', 'POSTGRES_PASSWORD=').replace(
        'BANTOOZI_APP_PASSWORD=bantoozi_app',
        'BANTOOZI_APP_PASSWORD=already-real-password',
      ),
    );
    run(['--production']);
    const v = vars();
    expect(v.POSTGRES_PASSWORD!.length).toBeGreaterThanOrEqual(24);
    expect(v.BANTOOZI_APP_PASSWORD).toBe('already-real-password');
  });

  it('--production replaces changeme placeholder role passwords (older prod.example.env)', () => {
    writeFileSync(
      join(dir, '.env'),
      TEMPLATE.replace('POSTGRES_PASSWORD=postgres', 'POSTGRES_PASSWORD=changeme0postgres0pw0000'),
    );
    run(['--production']);
    expect(vars().POSTGRES_PASSWORD).not.toMatch(/^changeme/u);
    expect(vars().POSTGRES_PASSWORD!.length).toBeGreaterThanOrEqual(24);
  });

  it('--production replaces the development passwords of .env.example (PR #28 review)', () => {
    writeFileSync(join(dir, '.env'), TEMPLATE);
    run(['--production']);
    const v = vars();
    for (const [name, dev] of Object.entries({
      POSTGRES_PASSWORD: 'postgres',
      BANTOOZI_OWNER_PASSWORD: 'bantoozi_owner',
      BANTOOZI_APP_PASSWORD: 'bantoozi_app',
      BANTOOZI_WORKER_PASSWORD: 'bantoozi_worker',
    })) {
      expect(v[name]).not.toBe(dev);
      expect(v[name]!.length).toBeGreaterThanOrEqual(24);
    }
  });

  it('leaves the dev database passwords untouched without --production', () => {
    writeFileSync(
      join(dir, '.env'),
      TEMPLATE.replace('BANTOOZI_WORKER_PASSWORD=bantoozi_worker', 'BANTOOZI_WORKER_PASSWORD='),
    );
    expect(run().status).toBe(0);
    const v = vars();
    expect(v.POSTGRES_PASSWORD).toBe('postgres');
    expect(v.BANTOOZI_OWNER_PASSWORD).toBe('bantoozi_owner');
    expect(v.BANTOOZI_APP_PASSWORD).toBe('bantoozi_app');
    expect(v.BANTOOZI_WORKER_PASSWORD).toBe('');
  });

  it('negative control: an env file with every secret already set is byte-identical after a run', () => {
    const key = randomBytes(32).toString('base64');
    const full = TEMPLATE.replace('change-me-to-a-long-random-string', 'p'.repeat(40))
      .replace('METRICS_TOKEN=change-me', `METRICS_TOKEN=${'m'.repeat(40)}`)
      .replace('PROVIDER_MASTER_KEY_ID=', 'PROVIDER_MASTER_KEY_ID=k20210101')
      .replace('PROVIDER_MASTER_KEYS=', `PROVIDER_MASTER_KEYS={"k20210101":"${key}"}`)
      .replace('DELETION_LEDGER_PATH=', 'DELETION_LEDGER_PATH=.data/ledger.age')
      .replace('DELETION_LEDGER_RECIPIENT=', `DELETION_LEDGER_RECIPIENT=age1${'q'.repeat(58)}`)
      .replace('DELETION_HMAC_KEY=', `DELETION_HMAC_KEY=${'a'.repeat(64)}`);
    writeFileSync(join(dir, '.env'), full);
    chmodSync(join(dir, '.env'), 0o600);
    const before = listFiles(dir).sort();
    const r = run();
    expect(r.status).toBe(0);
    expect(read()).toBe(full);
    expect(listFiles(dir).sort()).toEqual(before);
    expect(SECRET_NAMES.every((n) => vars()[n] !== '')).toBe(true);
  });

  function identityFile(): string {
    const file = listFiles(dir).find((f) => /AGE-SECRET-KEY-/u.test(readFileSync(f, 'utf8')));
    if (file === undefined) throw new Error('no ledger identity file written');
    return file;
  }
});
