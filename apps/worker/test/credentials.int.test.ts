import { Readable } from 'node:stream';

import {
  claimCredentialValidation,
  createDatabase,
  MIGRATIONS_FOLDER,
  PG_BOSS_VERSION,
  runMigrations,
  type Database,
} from '@bantoozi/db';
import { JEV_FAKE_MODEL } from '@bantoozi/engine';
import { parseJobPayload } from '@bantoozi/shared';
import { createLogger, type ProviderAuth } from '@bantoozi/shared/server';
import {
  createUser,
  dropCreatedTestDatabases,
  setupTestDatabase,
  startFakeTypeSafe,
  type FakeTypeSafeServer,
  type TestDatabase,
} from '@bantoozi/testing';
import { Command, CommanderError } from 'commander';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createWorkerCredentialResolver,
  isCredentialUnavailableError,
  openCredentialSession,
  registerCredentialCommands,
  type CredentialSessionConfig,
  type WorkerCredentialResolver,
} from '../src/credentials/index.js';
import { createWorkerEngineRouter } from '../src/engine-router.js';
import { createProviderValidateHandler } from '../src/handlers/provider-validate.js';

/**
 * Provider credentials on the worker (M2-T3, spec 04 §1.2) against a migrated database: the
 * resolver's source rules (environment bootstrap only without a row; staged and revoked rows block
 * it; decryption per attempt), the protected-stdin credentials CLI (stage → validate → activate →
 * revoke, status, master-key rewrap) with the fake TypeSafe server, and the rule that no plaintext
 * key reaches stdout/stderr, logs, queue payloads or stored rows.
 */

const K1 = Buffer.alloc(32, 1).toString('base64');
const K2 = Buffer.alloc(32, 2).toString('base64');
const ENV_KEY = 'env-bootstrap-jev-key-0001';
const DB_KEY_1 = 'db-jev-key-first-0001';
const DB_KEY_2 = 'db-jev-key-second-0002';
const ADMIN = 'ops-admin@example.test';
const SECRETS = [ENV_KEY, DB_KEY_1, DB_KEY_2];

let testDb: TestDatabase;
let owner: pg.Pool;
let workerPool: pg.Pool;
let db: Database;
let fake: FakeTypeSafeServer;
const logLines: string[] = [];
const logger = createLogger({
  name: 'credentials-test',
  level: 'debug',
  destination: { write: (line: string) => void logLines.push(line) },
});
const printed: string[] = [];

beforeAll(async () => {
  testDb = await setupTestDatabase({
    pkg: 'worker',
    migrationsDir: MIGRATIONS_FOLDER,
    pgBossVersion: PG_BOSS_VERSION,
    migrate: async (url) => {
      await runMigrations({ databaseUrl: url });
    },
  });
  owner = new pg.Pool({ connectionString: testDb.urls.owner, max: 2 });
  workerPool = new pg.Pool({ connectionString: testDb.urls.worker, max: 4 });
  db = createDatabase(workerPool);
  fake = await startFakeTypeSafe({ apiKey: DB_KEY_1 });
  await createUser(owner, { role: 'admin', email: ADMIN });
  await createUser(owner, { email: 'reader@example.test' });
});

afterAll(async () => {
  await fake?.close();
  await Promise.all([owner?.end(), workerPool?.end()]);
  await dropCreatedTestDatabases();
});

function sessionConfig(patch: Partial<CredentialSessionConfig> = {}): CredentialSessionConfig {
  return {
    nodeEnv: 'test',
    databaseUrlWorker: testDb.urls.worker,
    providerMasterKeyId: 'k1',
    providerMasterKeys: JSON.stringify({ k1: K1 }),
    typesafeApiKey: ENV_KEY,
    ollamaApiKey: undefined,
    typesafeBaseUrl: fake.url,
    typesafeModel: JEV_FAKE_MODEL,
    typesafePricePerMtokUsd: 0.042,
    engineConcurrency: 2,
    dailyBudgetUsd: 2,
    ollamaBaseUrl: 'http://127.0.0.1:9',
    ollamaModelFast: 'glm-5.3-flash',
    ollamaModelStrong: 'glm-5.3',
    ollamaMaxConcurrency: 1,
    llmFallbackEnabled: false,
    ...patch,
  };
}

function resolver(
  patch: {
    masterKeyId?: string | undefined;
    masterKeys?: string | undefined;
    envKey?: string | undefined;
  } = {},
): WorkerCredentialResolver {
  return createWorkerCredentialResolver({
    db,
    masterKeyId: 'masterKeyId' in patch ? patch.masterKeyId : 'k1',
    masterKeys: 'masterKeys' in patch ? patch.masterKeys : JSON.stringify({ k1: K1 }),
    envKeys: { typesafe: 'envKey' in patch ? patch.envKey : ENV_KEY },
    logger,
    metadataTtlMs: 0,
  });
}

/** The auth a resolver hands to `send` (the test only inspects it; production never keeps it). */
async function activeAuth(
  r: WorkerCredentialResolver,
  provider: 'typesafe' | 'ollama' = 'typesafe',
): Promise<ProviderAuth | string> {
  try {
    return await r.useActive(provider, new AbortController().signal, async (auth) => ({ ...auth }));
  } catch (error) {
    if (isCredentialUnavailableError(error)) return error.reason;
    throw error;
  }
}

interface CliRun {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Run one credentials command as `pnpm worker-cli …` would, with piped stdin. */
async function cli(
  args: string[],
  options: { stdin?: Readable; config?: Partial<CredentialSessionConfig> } = {},
): Promise<CliRun> {
  const out: string[] = [];
  const err: string[] = [];
  let exitCode = 0;
  const program = new Command('worker-cli').exitOverride().configureOutput({
    writeOut: (text) => void out.push(text),
    writeErr: (text) => void err.push(text),
  });
  registerCredentialCommands(program, {
    io: {
      stdin: options.stdin ?? Readable.from([]),
      stdout: { write: (text: string) => out.push(text) },
      stderr: { write: (text: string) => err.push(text) },
    },
    open: async () => openCredentialSession(sessionConfig(options.config), logger),
    setExitCode: (code) => {
      exitCode = code;
    },
    pollMs: 20,
  });
  try {
    await program.parseAsync(['node', 'worker-cli', ...args]);
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    exitCode = error.exitCode;
  }
  const run = { stdout: out.join(''), stderr: err.join(''), exitCode };
  printed.push(run.stdout, run.stderr);
  return run;
}

const pipe = (text: string) => Readable.from([Buffer.from(text)]);

async function storedText(): Promise<string> {
  const tables = ['provider_credentials', 'job_outbox', 'engine_calls', 'engine_reservations'];
  const parts: string[] = [];
  for (const table of tables) {
    const { rows } = await owner.query<{ row: string }>(
      `SELECT row_to_json(t)::text AS row FROM ${table} t`,
    );
    parts.push(...rows.map((r) => r.row));
  }
  return parts.join('\n');
}

/** No plaintext key anywhere the credentials code writes to. */
async function expectNoPlaintext(): Promise<void> {
  const everything = [...logLines, ...printed, await storedText()].join('\n');
  for (const secret of SECRETS) expect(everything).not.toContain(secret);
}

beforeEach(() => {
  fake.setOptions({ apiKey: DB_KEY_1, statusOverride: undefined, failRate: 0 });
});

describe('credential resolver and CLI lifecycle (spec 04 §1.2)', () => {
  it('uses the environment key only while no row exists', async () => {
    const r = resolver();
    expect(await r.metadata('typesafe')).toEqual({ source: 'env', enabled: true });
    expect(await r.metadata('ollama')).toEqual({ source: 'none', enabled: false });
    expect(await activeAuth(r)).toEqual({ apiKey: ENV_KEY, source: 'env' });
    expect(await activeAuth(r, 'ollama')).toBe('none');
    expect(r.keyring()).toEqual({ ok: true, activeKeyId: 'k1', keyIds: ['k1'] });

    const status = await cli(['credentials:status']);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain(
      'typesafe: source=env (bootstrap key; used only while no row exists)',
    );
    expect(status.stdout).toContain('ollama: source=none');
    expect(status.stdout).toContain('keyring: active=k1 keys=k1');
  });

  it('requires an active administrator and a usable keyring before reading a key', async () => {
    const noAdmin = await cli(['credentials:stage', 'typesafe'], { stdin: pipe(DB_KEY_1) });
    expect(noAdmin.exitCode).not.toBe(0);
    expect(noAdmin.stderr).toContain("required option '--admin <email>' not specified");

    const reader = await cli(['credentials:stage', 'typesafe', '--admin', 'reader@example.test'], {
      stdin: pipe(DB_KEY_1),
    });
    expect(reader).toMatchObject({ exitCode: 1 });
    expect(reader.stderr).toContain('FORBIDDEN');

    // Without the master keyring nothing is read or written.
    let read = false;
    const guarded = new Readable({
      read() {
        read = true;
        this.push(null);
      },
    });
    const missing = await cli(['credentials:stage', 'typesafe', '--admin', ADMIN], {
      stdin: guarded,
      config: { providerMasterKeyId: undefined, providerMasterKeys: undefined },
    });
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain('PROVIDER_MASTER_KEY_ID/PROVIDER_MASTER_KEYS are unusable');
    expect(read).toBe(false);

    const unknown = await cli(['credentials:stage', 'laya', '--admin', ADMIN]);
    expect(unknown).toMatchObject({ exitCode: 2 });
    const empty = await cli(['credentials:stage', 'typesafe', '--admin', ADMIN], {
      stdin: pipe('\n'),
    });
    expect(empty.exitCode).toBe(1);
    expect(empty.stderr).toContain('INVALID_SECRET');
    expect((await owner.query('SELECT 1 FROM provider_credentials')).rowCount).toBe(0);
  });

  it('stages from stdin, validates inline, activates, and serves the DB key per attempt', async () => {
    const r = resolver();
    const staged = await cli(['credentials:stage', 'typesafe', '--admin', ADMIN], {
      stdin: pipe(`${DB_KEY_1}\n`),
    });
    expect(staged.exitCode).toBe(0);
    expect(staged.stdout).toContain('staged typesafe candidate version 1 (revision 1, pending)');
    // A staged row without an active key blocks the environment fallback.
    expect(await activeAuth(r)).toBe('pending');
    expect(await r.metadata('typesafe')).toEqual({ source: 'db', enabled: false, revision: '1' });

    const validated = await cli(['credentials:validate', 'typesafe', '--admin', ADMIN, '--inline']);
    expect(validated.exitCode).toBe(0);
    expect(validated.stdout).toContain('candidate=1 status=valid');
    expect(validated.stdout).toContain('config=current');
    expect(validated.stdout).toContain('capabilities=choice,noul,score,systemone');
    // The probe used the candidate key and was recorded as a credential probe.
    expect(fake.requests.at(-1)?.headers['authorization']).toBe(`Bearer ${DB_KEY_1}`);
    const { rows: probes } = await owner.query<{ kind: string; credential_version: string }>(
      `SELECT kind, credential_version::text AS credential_version FROM engine_calls`,
    );
    expect(probes).toEqual([{ kind: 'credential_probe', credential_version: '1' }]);

    const activated = await cli(['credentials:activate', 'typesafe', '--admin', ADMIN]);
    expect(activated.exitCode).toBe(0);
    expect(activated.stdout).toContain('activated typesafe version 1 (revision 2)');
    expect(await activeAuth(r)).toEqual({
      apiKey: DB_KEY_1,
      source: 'db',
      credentialVersion: '1',
    });
    const status = await cli(['credentials:status']);
    expect(status.stdout).toContain('typesafe: source=db revision=2 enabled=yes active=1');
    await expectNoPlaintext();
  });

  it('queues validation without the key and waits for a worker to record it', async () => {
    const staged = await cli(['credentials:stage', 'typesafe', '--admin', ADMIN], {
      stdin: pipe(DB_KEY_2),
    });
    expect(staged.stdout).toContain('staged typesafe candidate version 3 (revision 3, pending)');
    fake.setOptions({ apiKey: DB_KEY_2 });
    // The active key stays usable while the replacement is staged.
    expect(await activeAuth(resolver())).toMatchObject({ credentialVersion: '1' });

    const waiting = cli(['credentials:validate', 'typesafe', '--admin', ADMIN, '--wait', '20']);
    // A worker consumes the intent: its payload names the candidate only.
    let payload: unknown;
    for (let i = 0; i < 200 && payload === undefined; i += 1) {
      const { rows } = await owner.query<{ payload: unknown }>(
        `SELECT payload FROM job_outbox WHERE queue = 'provider.validate' AND delivered_at IS NULL`,
      );
      payload = rows[0]?.payload;
      if (payload === undefined) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(payload).toEqual({ provider: 'typesafe', candidateVersion: '3' });
    const credentials = resolver();
    const handle = createProviderValidateHandler({
      db,
      router: createWorkerEngineRouter({ db, config: sessionConfig(), credentials, logger }),
      credentials,
      config: sessionConfig(),
      logger,
    });
    await handle(parseJobPayload('provider.validate', payload), {
      queue: 'provider.validate',
      jobId: 'test',
    });
    const result = await waiting;
    expect(result.stdout).toContain('queued provider.validate for typesafe candidate 3');
    expect(result.stdout).toContain('candidate=3 status=valid');
    await expectNoPlaintext();
  });

  it('lets two workers observe a hot rotation at their next attempt', async () => {
    const [first, second] = [resolver(), resolver()];
    expect(await activeAuth(first)).toMatchObject({ apiKey: DB_KEY_1, credentialVersion: '1' });
    expect(await activeAuth(second)).toMatchObject({ apiKey: DB_KEY_1, credentialVersion: '1' });
    const activated = await cli(['credentials:activate', 'typesafe', '--admin', ADMIN]);
    expect(activated.stdout).toContain('activated typesafe version 3 (revision 4)');
    expect(await activeAuth(first)).toEqual({
      apiKey: DB_KEY_2,
      source: 'db',
      credentialVersion: '3',
    });
    expect(await activeAuth(second)).toMatchObject({ apiKey: DB_KEY_2, credentialVersion: '3' });
  });

  it('serves the candidate only to the holder of its validation lease', async () => {
    await cli(['credentials:stage', 'typesafe', '--admin', ADMIN], { stdin: pipe(DB_KEY_1) });
    const lease = await claimCredentialValidation(db, {
      provider: 'typesafe',
      candidateVersion: '5',
      leaseMs: 60_000,
    });
    const r = resolver();
    const use = (token: string) =>
      r
        .useCandidate('typesafe', '5', token, new AbortController().signal, async (auth) => ({
          ...auth,
        }))
        .catch((error: unknown) => (isCredentialUnavailableError(error) ? error.reason : error));
    expect(await use(lease!.validationToken)).toEqual({
      apiKey: DB_KEY_1,
      source: 'db',
      credentialVersion: '5',
    });
    expect(await use('00000000-0000-4000-8000-000000000000')).toBe('lease_lost');
    // The active key is unaffected by the pending candidate.
    expect(await activeAuth(r)).toMatchObject({ apiKey: DB_KEY_2, credentialVersion: '3' });
  });

  it('validates again a candidate whose validator stopped, once its lease expired', async () => {
    // The lease above is never completed: its validator stopped without a result (D-87).
    const busy = await cli(['credentials:validate', 'typesafe', '--admin', ADMIN, '--inline']);
    expect(busy).toMatchObject({ exitCode: 1 });
    expect(busy.stderr).toContain('CONFLICT');
    expect((await cli(['credentials:status'])).stdout).toContain(
      'candidate=5 status=validating validated=',
    );
    await owner.query(
      `UPDATE provider_credentials SET validation_until = now() - interval '1 second'
        WHERE provider = 'typesafe'`,
    );
    expect((await cli(['credentials:status'])).stdout).toContain(
      'candidate=5 status=validating lease=expired validated=',
    );
    const validated = await cli(['credentials:validate', 'typesafe', '--admin', ADMIN, '--inline']);
    expect(validated.exitCode).toBe(0);
    expect(validated.stdout).toContain('candidate=5 status=valid validated=');
    await expectNoPlaintext();
  });

  it('rewraps stored keys under a new master key (rotation)', async () => {
    const rotated = {
      providerMasterKeyId: 'k2',
      providerMasterKeys: JSON.stringify({ k1: K1, k2: K2 }),
    };
    const run = await cli(['credentials:rewrap'], { config: rotated });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('typesafe: rewrapped 2 key(s) to k2, 0 already current');
    expect(run.stdout).toContain('ollama: rewrapped 0 key(s) to k2, 0 already current');
    const again = await cli(['credentials:rewrap', 'typesafe'], { config: rotated });
    expect(again.stdout).toContain('typesafe: rewrapped 0 key(s) to k2, 2 already current');

    // Only the new key is needed now; a host with only the retired key fails closed.
    const onlyNew = resolver({ masterKeyId: 'k2', masterKeys: JSON.stringify({ k2: K2 }) });
    expect(await activeAuth(onlyNew)).toMatchObject({ apiKey: DB_KEY_2, credentialVersion: '3' });
    const onlyOld = resolver();
    expect(await activeAuth(onlyOld)).toBe('decrypt_failed');
    expect(logLines.join('\n')).toContain('"cryptoCode":"UNKNOWN_KEY_ID"');
  });

  it('fails closed without a keyring or with a tampered envelope, never falling back to env', async () => {
    const noKeyring = resolver({ masterKeyId: undefined, masterKeys: undefined });
    expect(noKeyring.keyring()).toEqual({ ok: false, reason: 'missing' });
    expect(await activeAuth(noKeyring)).toBe('keyring_unavailable');
    const malformed = resolver({ masterKeyId: 'k2', masterKeys: '{"k2": "short"}' });
    expect(await activeAuth(malformed)).toBe('keyring_unavailable');

    await owner.query(
      `UPDATE provider_credentials
          SET active_envelope = jsonb_set(active_envelope, '{tag}', to_jsonb($1::text))
        WHERE provider = 'typesafe'`,
      [Buffer.alloc(16, 9).toString('base64')],
    );
    const rotatedHost = resolver({ masterKeyId: 'k2', masterKeys: JSON.stringify({ k2: K2 }) });
    expect(await activeAuth(rotatedHost)).toBe('decrypt_failed');
    const warnings = logLines.filter((line) => line.includes('provider credential unavailable'));
    expect(warnings.some((line) => line.includes('"reason":"keyring_unavailable"'))).toBe(true);
    expect(warnings.some((line) => line.includes('"cryptoCode":"DECRYPT_FAILED"'))).toBe(true);
    for (const line of warnings) expect(line).not.toMatch(/ciphertext|wrapped_key|nonce/);
  });

  it('revokes into a tombstone that blocks the environment fallback', async () => {
    const revoked = await cli(['credentials:revoke', 'typesafe', '--admin', ADMIN]);
    expect(revoked.exitCode).toBe(0);
    expect(revoked.stdout).toContain('revoked typesafe locally');
    expect(revoked.stdout).toContain("revoke it in the provider's dashboard");
    const r = resolver();
    expect(await activeAuth(r)).toBe('disabled');
    expect(await r.metadata('typesafe')).toMatchObject({ source: 'db', enabled: false });
    const status = await cli(['credentials:status']);
    expect(status.stdout).toContain(
      'revoked: no key is stored and the environment fallback is blocked',
    );
    // A stale revision is refused.
    const stale = await cli([
      'credentials:revoke',
      'typesafe',
      '--admin',
      ADMIN,
      '--expected-revision',
      '1',
    ]);
    expect(stale).toMatchObject({ exitCode: 1 });
    expect(stale.stderr).toContain('CONFLICT');
    await expectNoPlaintext();
  });

  it('caches metadata for at most the poll interval', async () => {
    let now = 0;
    const r = createWorkerCredentialResolver({
      db,
      masterKeyId: undefined,
      masterKeys: undefined,
      envKeys: {},
      now: () => now,
    });
    expect(await r.metadata('ollama')).toEqual({ source: 'none', enabled: false });
    await owner.query(
      `INSERT INTO provider_credentials (provider, revision, enabled) VALUES ('ollama', 1, false)`,
    );
    now = 9_999;
    expect(await r.metadata('ollama')).toEqual({ source: 'none', enabled: false });
    now = 10_000;
    expect(await r.metadata('ollama')).toEqual({ source: 'db', enabled: false, revision: '1' });
    // Admission never relies on the cache: the row is re-read for every attempt.
    expect(await activeAuth(r, 'ollama')).toBe('disabled');
  });
});
