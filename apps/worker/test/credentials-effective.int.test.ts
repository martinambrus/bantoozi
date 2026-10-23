import { Readable } from 'node:stream';

import { MIGRATIONS_FOLDER, PG_BOSS_VERSION, runMigrations } from '@bantoozi/db';
import { JEV_FAKE_MODEL } from '@bantoozi/engine';
import { createLogger } from '@bantoozi/shared/server';
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  openCredentialSession,
  registerCredentialCommands,
  type CredentialSessionConfig,
} from '../src/credentials/index.js';
import { loadEffectiveValues } from '../src/runtime.js';

import { baseConfig } from './support/m8b-t5-world.js';

/**
 * The credentials CLI judges the configuration the validation recorded: the EFFECTIVE one (stored
 * runtime settings over the environment), not the environment alone.
 */

const K1 = Buffer.alloc(32, 1).toString('base64');
const KEY = 'effective-jev-key-0001';
const ADMIN = 'effective-admin@example.test';

let testDb: TestDatabase;
let owner: pg.Pool;
let fake: FakeTypeSafeServer;
const logger = createLogger({ name: 'credentials-effective-test', level: 'silent' });

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
  fake = await startFakeTypeSafe({ apiKey: KEY });
  await createUser(owner, { role: 'admin', email: ADMIN });
  await owner.query(
    `INSERT INTO settings(key, value) VALUES ('engine.typesafe_base_url', to_jsonb($1::text))`,
    [fake.url],
  );
});

afterAll(async () => {
  await fake?.close();
  await owner?.end();
  await dropCreatedTestDatabases();
});

function envConfig() {
  return {
    ...baseConfig('test', { typesafeBaseUrl: 'http://127.0.0.1:9', typesafeModel: JEV_FAKE_MODEL }),
    databaseUrlWorker: testDb.urls.worker,
    providerMasterKeyId: 'k1',
    providerMasterKeys: JSON.stringify({ k1: K1 }),
    typesafeApiKey: undefined,
    ollamaApiKey: undefined,
  } as unknown as CredentialSessionConfig & Parameters<typeof loadEffectiveValues>[1];
}

async function cli(args: string[], stdin: Readable = Readable.from([])) {
  const out: string[] = [];
  const err: string[] = [];
  let exitCode = 0;
  const program = new Command('worker-cli').exitOverride().configureOutput({
    writeOut: (text) => void out.push(text),
    writeErr: (text) => void err.push(text),
  });
  const cfg = envConfig();
  registerCredentialCommands(program, {
    io: {
      stdin,
      stdout: { write: (text: string) => out.push(text) },
      stderr: { write: (text: string) => err.push(text) },
    },
    open: async () =>
      openCredentialSession(cfg, logger, { effective: (db) => loadEffectiveValues(db, cfg) }),
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
  return { stdout: out.join(''), stderr: err.join(''), exitCode };
}

const pipe = (text: string) => Readable.from([Buffer.from(text)]);

async function stageAndValidate() {
  const staged = await cli(['credentials:stage', 'typesafe', '--admin', ADMIN], pipe(KEY));
  expect(staged.exitCode).toBe(0);
  return cli(['credentials:validate', 'typesafe', '--admin', ADMIN, '--inline']);
}

describe('credentials CLI fingerprints the effective configuration', () => {
  it('a stored base URL that differs from the environment is the configuration validated and activated', async () => {
    const validated = await stageAndValidate();
    expect(validated.stdout).toContain('status=valid');
    expect(validated.stdout).toContain('config=current');

    const status = await cli(['credentials:status']);
    expect(status.stdout).toContain('config=current');

    const activated = await cli(['credentials:activate', 'typesafe', '--admin', ADMIN]);
    expect(activated.stderr).toBe('');
    expect(activated.exitCode).toBe(0);
    expect(activated.stdout).toContain('activated typesafe version');
  });

  it('a configuration change after validation still blocks activation', async () => {
    const validated = await stageAndValidate();
    expect(validated.stdout).toContain('status=valid');

    await owner.query(
      `UPDATE settings SET value = to_jsonb($1::text) WHERE key = 'engine.typesafe_base_url'`,
      ['http://127.0.0.1:9'],
    );
    const status = await cli(['credentials:status']);
    expect(status.stdout).toContain('config=changed');

    const activated = await cli(['credentials:activate', 'typesafe', '--admin', ADMIN]);
    expect(activated.exitCode).toBe(1);
    expect(activated.stderr).toContain('CONFLICT');
  });
});
