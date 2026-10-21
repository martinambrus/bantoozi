import {
  createDatabase,
  MIGRATIONS_FOLDER,
  PG_BOSS_VERSION,
  readCredentialMetadata,
  runMigrations,
  stageProviderCredential,
  type Database,
} from '@bantoozi/db';
import { JEV_FAKE_MODEL } from '@bantoozi/engine';
import { createLogger } from '@bantoozi/shared/server';
import { encryptProviderSecret, ProviderKeyring } from '@bantoozi/shared/server/credential-crypto';
import {
  dropCreatedTestDatabases,
  setupTestDatabase,
  startFakeOllama,
  startFakeTypeSafe,
  type FakeOllamaServer,
  type FakeTypeSafeServer,
  type TestDatabase,
} from '@bantoozi/testing';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createWorkerCredentialResolver,
  type CredentialProvider,
} from '../src/credentials/index.js';
import { createWorkerEngineRouter, type WorkerEngineConfig } from '../src/engine-router.js';
import {
  createProviderValidateHandler,
  type ProviderProbeConfig,
} from '../src/handlers/provider-validate.js';

/**
 * JEV-2-C (validate lane): with the configured model `jev-latest`, `provider.validate` builds the
 * TypeSafe probe lane with `resolveAlias` (also in production), sends the alias, and records the
 * concrete model the provider answered with.
 */
const K1 = Buffer.alloc(32, 1).toString('base64');
const JEV_KEY = 'alias-candidate-jev-key-0001';
const OLLAMA_KEY = 'alias-candidate-ollama-key-0002';
const ENV_KEY = 'alias-env-bootstrap-key-never-used';
const ALIAS = 'jev-latest';
const CONCRETE = 'jev-1.13.0';
const TABLE = { [ALIAS]: CONCRETE, [CONCRETE]: CONCRETE };

let testDb: TestDatabase;
let owner: pg.Pool;
let workerPool: pg.Pool;
let db: Database;
let jev: FakeTypeSafeServer;
let ollama: FakeOllamaServer;
const logLines: string[] = [];
const logger = createLogger({
  name: 'provider-validate-alias-test',
  level: 'debug',
  destination: { write: (line: string) => void logLines.push(line) },
});

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
  jev = await startFakeTypeSafe({ apiKey: JEV_KEY, models: TABLE });
  ollama = await startFakeOllama({ apiKey: OLLAMA_KEY });
});

afterAll(async () => {
  await Promise.all([jev?.close(), ollama?.close()]);
  await Promise.all([owner?.end(), workerPool?.end()]);
  await dropCreatedTestDatabases();
});

beforeEach(async () => {
  jev.setOptions({
    apiKey: JEV_KEY,
    models: TABLE,
    failRate: 0,
    failStatus: undefined,
    statusOverride: undefined,
  });
  jev.requests.splice(0);
  logLines.splice(0);
  await owner.query(`DELETE FROM engine_calls`);
  await owner.query(`DELETE FROM engine_reservations`);
  await owner.query(`DELETE FROM usage_daily`);
  await owner.query(`DELETE FROM job_outbox`);
  await owner.query(`DELETE FROM provider_credentials`);
  await owner.query(
    `DELETE FROM settings WHERE key IN ('engine.circuit', 'engine.daily_budget_usd', 'engine.budget_alerts')`,
  );
});

type TestConfig = ProviderProbeConfig & WorkerEngineConfig;

function testConfig(patch: Partial<TestConfig> = {}): TestConfig {
  return {
    nodeEnv: 'test',
    typesafeBaseUrl: jev.url,
    typesafeModel: JEV_FAKE_MODEL,
    typesafePricePerMtokUsd: 0.042,
    engineConcurrency: 2,
    dailyBudgetUsd: 2,
    ollamaBaseUrl: ollama.url,
    ollamaModelFast: 'glm-5.3-flash',
    ollamaModelStrong: 'glm-5.3',
    ollamaMaxConcurrency: 1,
    llmFallbackEnabled: false,
    ...patch,
  };
}

/**
 * The router (ledger) keeps a concrete model; the validate handler gets the probe config under test,
 * which is where the configured alias lives.
 */
function handler(probeConfig: Partial<TestConfig>) {
  const credentials = createWorkerCredentialResolver({
    db,
    masterKeyId: 'k1',
    masterKeys: JSON.stringify({ k1: K1 }),
    envKeys: { typesafe: ENV_KEY, ollama: ENV_KEY },
    logger,
    metadataTtlMs: 0,
  });
  const router = createWorkerEngineRouter({
    db,
    config: testConfig({ typesafeModel: CONCRETE }),
    credentials,
    logger,
    random: () => 0,
  });
  const handle = createProviderValidateHandler({
    db,
    router,
    credentials,
    config: testConfig(probeConfig),
    logger,
    random: () => 0,
  });
  return (provider: CredentialProvider, candidateVersion: string) =>
    handle({ provider, candidateVersion }, { queue: 'provider.validate', jobId: 'test' });
}

async function stage(provider: CredentialProvider, secret: string): Promise<string> {
  const parsed = ProviderKeyring.parse('k1', JSON.stringify({ k1: K1 }));
  if (!parsed.ok) throw new Error('test keyring');
  const expectedRevision = (await readCredentialMetadata(db, provider))?.revision ?? '0';
  const secretVersion = String(BigInt(expectedRevision) + 1n);
  const envelope = encryptProviderSecret({
    keyring: parsed.keyring,
    provider,
    secretVersion,
    secret,
  });
  return (await stageProviderCredential(db, { provider, expectedRevision, envelope }))
    .candidateVersion;
}

async function typesafe() {
  const record = await readCredentialMetadata(db, 'typesafe');
  if (record === null) throw new Error('no typesafe row');
  return record;
}

const sentModels = () => jev.requests.map((r) => (r.body as { model: string }).model);
const notConfiguredLogs = (provider: string) =>
  logLines.filter(
    (l) => l.includes('provider probe is not configured') && l.includes(`"provider":"${provider}"`),
  );

describe('provider.validate with the configured model jev-latest', () => {
  it('V1 records valid with the concrete model the provider answered; the fake saw the alias', async () => {
    const version = await stage('typesafe', JEV_KEY);
    await handler({ typesafeModel: ALIAS })('typesafe', version);
    expect(await typesafe()).toMatchObject({
      candidateVersion: version,
      candidateStatus: 'valid',
      lastErrorCode: null,
    });
    expect((await typesafe()).candidateValidation).toMatchObject({ model: CONCRETE });
    expect(sentModels()).toEqual([ALIAS]);
    expect(notConfiguredLogs('typesafe')).toEqual([]);

    // Control: the configured concrete model behaves as today.
    jev.requests.splice(0);
    const next = await stage('typesafe', JEV_KEY);
    await handler({ typesafeModel: CONCRETE })('typesafe', next);
    expect(await typesafe()).toMatchObject({ candidateVersion: next, candidateStatus: 'valid' });
    expect((await typesafe()).candidateValidation).toMatchObject({ model: CONCRETE });
    expect(sentModels()).toEqual([CONCRETE]);
  });

  it('V2 in production the alias builds the probe lane without the not-configured log', async () => {
    const production = {
      nodeEnv: 'production' as const,
      typesafeBaseUrl: 'https://jev.example.test',
      ollamaBaseUrl: 'https://ollama.example.test',
    };
    handler({ ...production, typesafeModel: ALIAS });
    expect(notConfiguredLogs('typesafe')).toEqual([]);
    // Control: a refused production model still logs it, a concrete one does not.
    handler({ ...production, typesafeModel: 'jev-fake' });
    expect(notConfiguredLogs('typesafe')).toHaveLength(1);
    logLines.splice(0);
    handler({ ...production, typesafeModel: CONCRETE });
    expect(notConfiguredLogs('typesafe')).toEqual([]);
  });

  it('V3 an alias the provider does not know is not recorded valid', async () => {
    jev.setOptions({ models: {} });
    const version = await stage('typesafe', JEV_KEY);
    await handler({ typesafeModel: ALIAS })('typesafe', version);
    // The probe reached the wire with the alias and was refused.
    expect(sentModels()).toEqual([ALIAS]);
    expect((await typesafe()).candidateStatus).not.toBe('valid');

    // Control: once the provider knows the alias, a new candidate validates.
    jev.setOptions({ models: TABLE });
    jev.requests.splice(0);
    const next = await stage('typesafe', JEV_KEY);
    await handler({ typesafeModel: ALIAS })('typesafe', next);
    expect(await typesafe()).toMatchObject({ candidateVersion: next, candidateStatus: 'valid' });
  });
});
