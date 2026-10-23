import { createDatabase, MIGRATIONS_FOLDER, PG_BOSS_VERSION, runMigrations } from '@bantoozi/db';
import { CLOSED_BREAKER, defaultCircuit, enterAuthMode, JEV_FAKE_MODEL } from '@bantoozi/engine';
import { conservativeRequestTokens, EngineModelProbeSchema } from '@bantoozi/shared';
import { createLogger, type ProviderAuth } from '@bantoozi/shared/server';
import {
  dropCreatedTestDatabases,
  setupTestDatabase,
  startFakeTypeSafe,
  type FakeTypeSafeServer,
  type TestDatabase,
} from '@bantoozi/testing';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createWorkerCredentialResolver,
  type CredentialProvider,
} from '../src/credentials/index.js';
import { createWorkerEngineRouter, type WorkerEngineConfig } from '../src/engine-router.js';
import {
  createModelProber,
  MODEL_PROBE_MAX_ATTEMPTS,
  MODEL_PROBE_MAX_SPEND_USD,
  MODEL_PROBE_QUESTIONS,
  MODEL_PROBE_STATE,
} from '../src/model-probe.js';

/**
 * JEV-1 (worker): the Jev model probe against a migrated database and the fake TypeSafe server.
 * One synthetic request asks which concrete model an id maps to; every wire attempt is reserved and
 * recorded as a `model_probe` call through the normal spend guard, there are at most 2 attempts and
 * $0.002 reserved, the circuit breaker is never touched, and no plaintext key is written anywhere.
 */

const API_KEY = 'model-probe-env-key-0001';
const WRONG_KEY = 'model-probe-wrong-key-0002';
const SECRETS = [API_KEY, WRONG_KEY];
const TABLE = { 'jev-latest': 'jev-1.13.0', 'jev-1.13.0': 'jev-1.13.0' };

let testDb: TestDatabase;
let owner: pg.Pool;
let workerPool: pg.Pool;
let fake: FakeTypeSafeServer;
const logLines: string[] = [];
const logger = createLogger({
  name: 'model-probe-test',
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
  fake = await startFakeTypeSafe({ apiKey: API_KEY, models: TABLE });
}, 240_000);

afterAll(async () => {
  await fake?.close();
  await Promise.all([owner?.end(), workerPool?.end()]);
  await dropCreatedTestDatabases();
});

beforeEach(async () => {
  fake.setOptions({
    apiKey: API_KEY,
    models: TABLE,
    failRate: 0,
    failStatus: undefined,
    statusOverride: undefined,
  });
  fake.requests.splice(0);
  logLines.splice(0);
  await owner.query(`DELETE FROM engine_calls`);
  await owner.query(`DELETE FROM engine_reservations`);
  await owner.query(`DELETE FROM usage_daily`);
  await owner.query(`DELETE FROM provider_credentials`);
  await owner.query(
    `DELETE FROM settings WHERE key IN ('engine.circuit', 'engine.daily_budget_usd', 'engine.budget_alerts')`,
  );
});

function routerConfig(): WorkerEngineConfig {
  return {
    nodeEnv: 'test',
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
  };
}

/** A prober over the real router (ledger) and the env-key resolver; `price` is read per probe. */
function setup(options: { price?: number; envKey?: string | null } = {}) {
  const db = createDatabase(workerPool);
  const credentials = createWorkerCredentialResolver({
    db,
    masterKeyId: undefined,
    masterKeys: undefined,
    envKeys: options.envKey === null ? {} : { typesafe: options.envKey ?? API_KEY },
    logger,
    metadataTtlMs: 0,
  });
  const ledger = createWorkerEngineRouter({ db, config: routerConfig(), credentials, logger });
  const config = {
    nodeEnv: 'test' as const,
    typesafeBaseUrl: fake.url,
    typesafePricePerMtokUsd: options.price ?? 0.042,
  };
  const prober = createModelProber({
    ledger,
    credentials,
    config,
    logger,
    random: () => 0,
  });
  return { prober, config, ledger, credentials };
}

interface CallRow {
  engine: string;
  kind: string;
  model: string | null;
  status: string;
  attempts: number;
  logical_request_id: string;
}

async function calls(): Promise<CallRow[]> {
  const { rows } = await owner.query<CallRow>(
    `SELECT engine, kind, model, status, attempts, logical_request_id::text AS logical_request_id
       FROM engine_calls ORDER BY id`,
  );
  return rows;
}

async function reservations(): Promise<Array<{ kind: string; status: string; reserved: number }>> {
  const { rows } = await owner.query<{ kind: string; status: string; reserved: string }>(
    `SELECT kind, status, reserved_usd::text AS reserved FROM engine_reservations ORDER BY created_at`,
  );
  return rows.map((r) => ({ ...r, reserved: Number(r.reserved) }));
}

async function circuitText(): Promise<string | null> {
  const { rows } = await owner.query<{ value: string }>(
    `SELECT value::text AS value FROM settings WHERE key = 'engine.circuit'`,
  );
  return rows[0]?.value ?? null;
}

/** A breaker already in auth mode, so "unchanged" proves the probe neither reset nor tripped it. */
async function seedCircuit(): Promise<string | null> {
  const circuit = { ...defaultCircuit(), typesafe: enterAuthMode(CLOSED_BREAKER, new Date()) };
  await owner.query(`INSERT INTO settings (key, value) VALUES ('engine.circuit', $1::jsonb)`, [
    JSON.stringify(circuit),
  ]);
  return circuitText();
}

const total = (rows: Array<{ reserved: number }>) => rows.reduce((sum, r) => sum + r.reserved, 0);

/** A price at which one attempt reserves `usd`. */
function priceFor(usd: number): number {
  const tokens = conservativeRequestTokens(MODEL_PROBE_STATE, MODEL_PROBE_QUESTIONS);
  return (usd * 1_000_000) / tokens;
}

describe('model probe: resolution', () => {
  it('W1 resolves jev-latest to a concrete id with one reserved, recorded request', async () => {
    const circuitBefore = await seedCircuit();
    const { prober } = setup();
    const probe = await prober.probe('jev-latest');

    expect(probe).toMatchObject({ requested: 'jev-latest', answered: 'jev-1.13.0', ok: true });
    expect(probe).not.toHaveProperty('error');
    expect(EngineModelProbeSchema.safeParse(probe).success).toBe(true);

    expect(fake.requests).toHaveLength(1);
    const body = fake.requests[0]?.body as { model: string; state: unknown; questions: unknown };
    expect(body.model).toBe('jev-latest');
    expect(body.state).toEqual(MODEL_PROBE_STATE);
    expect(body.questions).toEqual(MODEL_PROBE_QUESTIONS);

    expect(await calls()).toMatchObject([
      { engine: 'typesafe', kind: 'model_probe', model: 'jev-1.13.0', status: 'ok', attempts: 1 },
    ]);
    const reserved = await reservations();
    expect(reserved).toHaveLength(1);
    expect(reserved[0]).toMatchObject({ kind: 'model_probe', status: 'settled' });
    expect(reserved[0]!.reserved).toBeLessThanOrEqual(MODEL_PROBE_MAX_SPEND_USD);
    const { rows: usage } = await owner.query<{ engine: string; kind: string; calls: number }>(
      `SELECT engine, kind, calls FROM usage_daily`,
    );
    expect(usage).toEqual([{ engine: 'typesafe', kind: 'model_probe', calls: 1 }]);
    expect(await circuitText()).toBe(circuitBefore);
  });

  it('W2 control: the answered id follows the server table', async () => {
    fake.setOptions({ models: { 'jev-latest': 'jev-1.14.0' } });
    const probe = await setup().prober.probe('jev-latest');
    expect(probe).toMatchObject({ requested: 'jev-latest', answered: 'jev-1.14.0', ok: true });
    expect((await calls())[0]?.model).toBe('jev-1.14.0');
  });

  it('W3 a concrete id served as itself is ok; one served as another id is a mismatch', async () => {
    const same = await setup().prober.probe('jev-1.13.0');
    expect(same).toMatchObject({ requested: 'jev-1.13.0', answered: 'jev-1.13.0', ok: true });
    expect(same).not.toHaveProperty('error');
    expect(fake.requests).toHaveLength(1);

    fake.requests.splice(0);
    fake.setOptions({ models: { 'jev-1.12.0': 'jev-1.13.0' } });
    const mismatch = await setup().prober.probe('jev-1.12.0');
    expect(mismatch).toMatchObject({
      requested: 'jev-1.12.0',
      answered: 'jev-1.13.0',
      ok: false,
      error: 'model_mismatch',
    });
    expect(fake.requests).toHaveLength(1);
  });

  it('W4 an unknown id is model_unavailable after one request, recorded as an error', async () => {
    const probe = await setup().prober.probe('jev-1.99.0');
    expect(probe).toMatchObject({ requested: 'jev-1.99.0', ok: false, error: 'model_unavailable' });
    expect(probe.answered).toBeUndefined();
    expect(fake.requests).toHaveLength(1);
    expect(await calls()).toMatchObject([
      { kind: 'model_probe', status: 'error', model: 'jev-1.99.0', attempts: 1 },
    ]);
    // Control: the same table resolves a known id.
    fake.requests.splice(0);
    expect(await setup().prober.probe('jev-latest')).toMatchObject({ ok: true });
  });

  it('W5 an alias answered with the alias is unresolved', async () => {
    fake.setOptions({ models: { 'jev-latest': 'jev-latest' } });
    const probe = await setup().prober.probe('jev-latest');
    expect(probe).toMatchObject({
      requested: 'jev-latest',
      answered: 'jev-latest',
      ok: false,
      error: 'alias_unresolved',
    });
    expect(fake.requests).toHaveLength(1);
  });

  it('W12 a 404 with the legacy body is model_unavailable without a retry', async () => {
    fake.setOptions({ statusOverride: () => ({ status: 404 }) });
    const probe = await setup().prober.probe('jev-latest');
    expect(probe).toMatchObject({ ok: false, error: 'model_unavailable' });
    expect(fake.requests).toHaveLength(1);
  });
});

describe('model probe: attempts and spend', () => {
  it('W6 retries one transient 503 and stops at two attempts', async () => {
    let seen = 0;
    fake.setOptions({ statusOverride: () => (++seen === 1 ? { status: 503 } : undefined) });
    const probe = await setup().prober.probe('jev-latest');
    expect(probe).toMatchObject({ requested: 'jev-latest', answered: 'jev-1.13.0', ok: true });
    expect(fake.requests).toHaveLength(2);
    const rows = await calls();
    expect(rows.map((r) => [r.attempts, r.status])).toEqual([
      [1, 'error'],
      [2, 'ok'],
    ]);
    expect(new Set(rows.map((r) => r.logical_request_id)).size).toBe(1);
    expect(rows.every((r) => r.kind === 'model_probe')).toBe(true);
  });

  it('W6 a persistent 503 is provider_unavailable after exactly two requests', async () => {
    expect(MODEL_PROBE_MAX_ATTEMPTS).toBe(2);
    fake.setOptions({ failRate: 1, failStatus: 503 });
    const probe = await setup().prober.probe('jev-latest');
    expect(probe).toMatchObject({ ok: false, error: 'provider_unavailable' });
    expect(fake.requests).toHaveLength(2);
    const rows = await calls();
    expect(rows.map((r) => r.attempts)).toEqual([1, 2]);
    expect(new Set(rows.map((r) => r.logical_request_id)).size).toBe(1);
    const reserved = await reservations();
    expect(reserved).toHaveLength(2);
    expect(total(reserved)).toBeLessThanOrEqual(MODEL_PROBE_MAX_SPEND_USD);
  });

  it('W8 a further attempt above the spend bound is not made', async () => {
    // One attempt reserves 0.0012, two would reserve 0.0024 > 0.002.
    const price = priceFor(0.0012);
    fake.setOptions({ failRate: 1, failStatus: 503 });
    const probe = await setup({ price }).prober.probe('jev-latest');
    expect(probe).toMatchObject({ ok: false, error: 'probe_budget_exceeded' });
    expect(fake.requests).toHaveLength(1);
    const reserved = await reservations();
    expect(reserved).toHaveLength(1);
    expect(reserved[0]!.reserved).toBeCloseTo(0.0012, 6);

    // Control: at the default price the same failure makes both attempts.
    fake.requests.splice(0);
    const control = await setup().prober.probe('jev-latest');
    expect(control).toMatchObject({ ok: false, error: 'provider_unavailable' });
    expect(fake.requests).toHaveLength(2);
  });

  it('W8 the price is read on every probe', async () => {
    const { prober, config } = setup();
    fake.setOptions({ failRate: 1, failStatus: 503 });
    expect(await prober.probe('jev-latest')).toMatchObject({ error: 'provider_unavailable' });
    expect(fake.requests).toHaveLength(2);
    fake.requests.splice(0);
    config.typesafePricePerMtokUsd = priceFor(0.0012);
    expect(await prober.probe('jev-latest')).toMatchObject({ error: 'probe_budget_exceeded' });
    expect(fake.requests).toHaveLength(1);
  });

  it('W9 a zero daily budget refuses the probe before anything is sent', async () => {
    await owner.query(`INSERT INTO settings (key, value) VALUES ('engine.daily_budget_usd', '0')`);
    const probe = await setup().prober.probe('jev-latest');
    expect(probe).toMatchObject({ ok: false, error: 'budget_unavailable' });
    expect(fake.requests).toHaveLength(0);
    expect(await calls()).toEqual([]);
    // Control: with the budget restored the same probe is sent.
    await owner.query(`DELETE FROM settings WHERE key = 'engine.daily_budget_usd'`);
    expect(await setup().prober.probe('jev-latest')).toMatchObject({ ok: true });
    expect(fake.requests).toHaveLength(1);
  });
});

describe('model probe: credentials, signals and safety', () => {
  it('W7 a rejected key is auth_rejected after one request and leaves the breaker alone', async () => {
    const circuitBefore = await seedCircuit();
    fake.setOptions({ apiKey: WRONG_KEY });
    const probe = await setup().prober.probe('jev-latest');
    expect(probe).toMatchObject({ ok: false, error: 'auth_rejected' });
    expect(fake.requests).toHaveLength(1);
    expect(await circuitText()).toBe(circuitBefore);
    expect(await calls()).toMatchObject([{ kind: 'model_probe', status: 'auth_error' }]);
  });

  it('W10 without a credential nothing is sent', async () => {
    const probe = await setup({ envKey: null }).prober.probe('jev-latest');
    expect(probe.ok).toBe(false);
    expect(probe.error).toMatch(/^no_key/);
    expect(fake.requests).toHaveLength(0);
  });

  it('W11 an aborted signal is a timeout with nothing sent or recorded', async () => {
    const probe = await setup().prober.probe('jev-latest', { signal: AbortSignal.abort() });
    expect(probe).toMatchObject({ ok: false, error: 'timeout' });
    expect(fake.requests).toHaveLength(0);
    expect(await calls()).toEqual([]);
    expect((await reservations()).filter((r) => r.status === 'reserved')).toEqual([]);
    // Control: without the signal the same probe is sent.
    expect(await setup().prober.probe('jev-latest')).toMatchObject({ ok: true });
    expect(fake.requests).toHaveLength(1);
  });

  it('W11b a signal aborted during the credential lookup reserves and sends nothing', async () => {
    const { ledger, credentials, config } = setup();
    const controller = new AbortController();
    const abortingLookup = {
      ...credentials,
      useActive: <T>(
        provider: CredentialProvider,
        signal: AbortSignal,
        send: (auth: ProviderAuth) => Promise<T>,
      ) => {
        controller.abort();
        return credentials.useActive(provider, signal, send);
      },
    };
    const reserve = vi.spyOn(ledger, 'reserveExternalCall');
    const prober = createModelProber({
      ledger,
      credentials: abortingLookup,
      config,
      logger,
      random: () => 0,
    });
    const probe = await prober.probe('jev-latest', { signal: controller.signal });
    expect(probe).toMatchObject({ ok: false, error: 'timeout' });
    expect(reserve).not.toHaveBeenCalled();
    expect(fake.requests).toHaveLength(0);
    expect(await calls()).toEqual([]);
  });

  it('W13 uses the configured loopback base url and writes no plaintext key', async () => {
    expect(fake.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
    fake.setOptions({ failRate: 1, failStatus: 503 });
    await setup().prober.probe('jev-latest');
    fake.setOptions({ failRate: 0, apiKey: WRONG_KEY });
    await setup().prober.probe('jev-latest');
    expect(fake.requests.length).toBeGreaterThan(0);
    for (const request of fake.requests) {
      expect(request.headers['host']).toMatch(/^127\.0\.0\.1:/);
    }
    const parts: string[] = [...logLines];
    for (const table of ['engine_calls', 'engine_reservations', 'usage_daily', 'settings']) {
      const { rows } = await owner.query<{ row: string }>(
        `SELECT row_to_json(t)::text AS row FROM ${table} t`,
      );
      parts.push(...rows.map((r) => r.row));
    }
    const everything = parts.join('\n');
    expect(everything.length).toBeGreaterThan(0);
    for (const secret of SECRETS) expect(everything).not.toContain(secret);
  });

  it('W14 an id that is not a model id is unsupported and never sent', async () => {
    const probe = await setup().prober.probe('bogus id');
    expect(probe).toMatchObject({ requested: 'bogus id', ok: false, error: 'unsupported_model' });
    expect(fake.requests).toHaveLength(0);
    expect(await calls()).toEqual([]);
    // Control: a well-formed id is sent.
    expect(await setup().prober.probe('jev-latest')).toMatchObject({ ok: true });
  });
});
