import {
  claimCredentialValidation,
  createDatabase,
  MIGRATIONS_FOLDER,
  PG_BOSS_VERSION,
  readCredentialMetadata,
  runMigrations,
  setProviderCredentialEnabled,
  stageProviderCredential,
  type CredentialMetadataRecord,
  type Database,
} from '@bantoozi/db';
import {
  CLOSED_BREAKER,
  createTypeSafeEngine,
  defaultCircuit,
  enterAuthMode,
  JEV_FAKE_MODEL,
  typesafeCostUsd,
  type DecisionEngine,
} from '@bantoozi/engine';
import { conservativeRequestTokens, PLATFORM_USER_ID } from '@bantoozi/shared';
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
  providerConfigFingerprint,
  type CredentialProvider,
  type WorkerCredentialResolver,
} from '../src/credentials/index.js';
import { createWorkerEngineRouter, type WorkerEngineConfig } from '../src/engine-router.js';
import {
  createProviderValidateHandler,
  MAX_PROBE_SPEND_USD,
  PROBE_MAX_OUTPUT_TOKENS,
  PROBE_STATE,
  TYPESAFE_PROBE_QUESTIONS,
  type ProviderProbeConfig,
  type ProviderValidateDeps,
} from '../src/handlers/provider-validate.js';

/**
 * `provider.validate` (M2-T3, spec 04 §1.2 step 2) against a migrated database and the fake
 * provider servers: the candidate key is probed with synthetic data only, every attempt reserves
 * and records a `credential_probe` call through the normal spend guard, the action stays within 3
 * attempts and $0.02, the active credential's breaker is never touched, a lost lease discards the
 * result, and no plaintext key reaches logs, the outbox or audit rows.
 */

const K1 = Buffer.alloc(32, 1).toString('base64');
const K2 = Buffer.alloc(32, 2).toString('base64');
const JEV_KEY = 'candidate-jev-key-0001';
const WRONG_KEY = 'candidate-jev-key-wrong-0002';
const OLLAMA_KEY = 'candidate-ollama-key-0003';
/** A bootstrap key that must never be used: every provider here has a row. */
const ENV_KEY = 'env-bootstrap-key-never-used';
const SECRETS = [JEV_KEY, WRONG_KEY, OLLAMA_KEY, ENV_KEY];

let testDb: TestDatabase;
let owner: pg.Pool;
let workerPool: pg.Pool;
let db: Database;
let jev: FakeTypeSafeServer;
let ollama: FakeOllamaServer;
const logLines: string[] = [];
const logger = createLogger({
  name: 'provider-validate-test',
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
  jev = await startFakeTypeSafe({ apiKey: JEV_KEY });
  ollama = await startFakeOllama({ apiKey: OLLAMA_KEY });
});

afterAll(async () => {
  await Promise.all([jev?.close(), ollama?.close()]);
  await Promise.all([owner?.end(), workerPool?.end()]);
  await dropCreatedTestDatabases();
});

beforeEach(async () => {
  jev.setOptions({ apiKey: JEV_KEY, failRate: 0, statusOverride: undefined });
  jev.requests.splice(0);
  ollama.requests.splice(0);
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

/** The worker resolver with this host's keyring; `null` is a host without one. */
function resolver(masterKeys: string | null = JSON.stringify({ k1: K1 })) {
  return createWorkerCredentialResolver({
    db,
    masterKeyId: masterKeys === null ? undefined : 'k1',
    masterKeys: masterKeys ?? undefined,
    envKeys: { typesafe: ENV_KEY, ollama: ENV_KEY },
    logger,
    metadataTtlMs: 0,
  });
}

/** A worker's `provider.validate` handler over the real router, resolver and fake servers. */
function handler(
  options: {
    config?: Partial<TestConfig>;
    probeConfig?: Partial<TestConfig>;
    credentials?: WorkerCredentialResolver;
    engines?: ProviderValidateDeps['engines'];
  } = {},
) {
  const config = testConfig(options.config);
  const credentials = options.credentials ?? resolver();
  const router = createWorkerEngineRouter({ db, config, credentials, logger, random: () => 0 });
  const handle = createProviderValidateHandler({
    db,
    router,
    credentials,
    config: testConfig({ ...options.config, ...options.probeConfig }),
    logger,
    random: () => 0,
    ...(options.engines === undefined ? {} : { engines: options.engines }),
  });
  return {
    router,
    validate: (provider: CredentialProvider, candidateVersion: string) =>
      handle({ provider, candidateVersion }, { queue: 'provider.validate', jobId: 'test' }),
  };
}

/** The real TypeSafe adapter against the fake server (wrapped by tests that act mid-call). */
const realJev = () =>
  createTypeSafeEngine({
    baseUrl: jev.url,
    model: JEV_FAKE_MODEL,
    pricePerMTokUsd: 0.042,
    production: false,
    allowFakeModel: true,
  });

/** Stage `secret` as the next candidate, encrypted as the CLI or admin API would. */
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
  const staged = await stageProviderCredential(db, { provider, expectedRevision, envelope });
  return staged.candidateVersion;
}

async function metadata(provider: CredentialProvider): Promise<CredentialMetadataRecord> {
  const record = await readCredentialMetadata(db, provider);
  if (record === null) throw new Error(`no ${provider} row`);
  return record;
}

type CallRow = {
  engine: string;
  kind: string;
  model: string | null;
  status: string;
  attempts: number;
  credential_version: string | null;
  logical_request_id: string;
  reservation_id: string | null;
  user_id: string | null;
  billing: string;
  cost_usd: string;
};

async function calls(): Promise<CallRow[]> {
  const { rows } = await owner.query<CallRow>(
    `SELECT engine, kind, model, status, attempts, credential_version::text AS credential_version,
            logical_request_id::text AS logical_request_id, reservation_id::text AS reservation_id,
            user_id::text AS user_id, billing, cost_usd::text AS cost_usd
       FROM engine_calls ORDER BY id`,
  );
  return rows;
}

async function reservations(): Promise<
  Array<{ kind: string; status: string; reserved_usd: number; user_id: string | null }>
> {
  const { rows } = await owner.query<{
    kind: string;
    status: string;
    reserved_usd: string;
    user_id: string | null;
  }>(
    `SELECT kind, status, reserved_usd::text AS reserved_usd, user_id::text AS user_id
       FROM engine_reservations ORDER BY created_at`,
  );
  return rows.map((row) => ({ ...row, reserved_usd: Number(row.reserved_usd) }));
}

async function circuitText(): Promise<string | null> {
  const { rows } = await owner.query<{ value: string }>(
    `SELECT value::text AS value FROM settings WHERE key = 'engine.circuit'`,
  );
  return rows[0]?.value ?? null;
}

/** No plaintext key in the captured logs or anything the probe wrote. */
async function expectNoPlaintext(): Promise<void> {
  const parts: string[] = [...logLines];
  for (const table of ['provider_credentials', 'job_outbox', 'engine_calls', 'settings']) {
    const { rows } = await owner.query<{ row: string }>(
      `SELECT row_to_json(t)::text AS row FROM ${table} t`,
    );
    parts.push(...rows.map((r) => r.row));
  }
  const everything = parts.join('\n');
  for (const secret of SECRETS) expect(everything).not.toContain(secret);
}

const lastLog = (message: string): Record<string, unknown> | undefined => {
  const line = logLines.filter((l) => l.includes(`"msg":"${message}"`)).at(-1);
  return line === undefined ? undefined : (JSON.parse(line) as Record<string, unknown>);
};

describe('provider.validate (spec 04 §1.2 step 2)', () => {
  it('validates a Jev candidate with synthetic data through the spend guard', async () => {
    // The active credential's breaker is in auth mode; validating a candidate never resets it.
    const circuit = { ...defaultCircuit(), typesafe: enterAuthMode(CLOSED_BREAKER, new Date()) };
    await owner.query(`INSERT INTO settings (key, value) VALUES ('engine.circuit', $1::jsonb)`, [
      JSON.stringify(circuit),
    ]);
    const circuitBefore = await circuitText();
    const version = await stage('typesafe', JEV_KEY);
    await handler().validate('typesafe', version);

    const record = await metadata('typesafe');
    expect(record).toMatchObject({
      candidateVersion: version,
      candidateStatus: 'valid',
      lastErrorCode: null,
      // No automatic promotion after validation.
      activeVersion: null,
      enabled: false,
    });
    expect(record.validatedAt).toBeInstanceOf(Date);
    expect(record.candidateValidation).toMatchObject({
      configFingerprint: providerConfigFingerprint('typesafe', testConfig()),
      model: JEV_FAKE_MODEL,
      attempts: 1,
      capabilities: { systemone: true, noul: true, choice: true, score: true },
    });
    expect(typeof record.candidateValidation.checkedAt).toBe('string');
    expect(typeof record.candidateValidation.latencyMs).toBe('number');

    // One wire attempt with the candidate key and synthetic content only.
    expect(jev.requests).toHaveLength(1);
    const [request] = jev.requests;
    expect(request?.headers['authorization']).toBe(`Bearer ${JEV_KEY}`);
    expect(request?.body).toMatchObject({ model: JEV_FAKE_MODEL, state: PROBE_STATE });
    expect(Object.keys((request?.body as { questions: object }).questions).sort()).toEqual([
      'choice',
      'noul',
      'score',
    ]);

    // Reserved, recorded and settled as a credential probe of the platform.
    const [call, ...more] = await calls();
    expect(more).toEqual([]);
    expect(call).toMatchObject({
      engine: 'typesafe',
      kind: 'credential_probe',
      model: JEV_FAKE_MODEL,
      status: 'ok',
      attempts: 1,
      credential_version: version,
      billing: 'known',
      user_id: null,
    });
    expect(call?.reservation_id).not.toBeNull();
    expect(Number(call?.cost_usd)).toBeGreaterThan(0);
    const [reservation] = await reservations();
    expect(reservation).toMatchObject({ kind: 'credential_probe', status: 'settled' });
    expect(reservation?.reserved_usd).toBeLessThanOrEqual(MAX_PROBE_SPEND_USD);
    const { rows: usage } = await owner.query<{ user_id: string; kind: string; calls: number }>(
      `SELECT user_id::text AS user_id, kind, calls FROM usage_daily`,
    );
    expect(usage).toEqual([{ user_id: PLATFORM_USER_ID, kind: 'credential_probe', calls: 1 }]);

    expect(await circuitText()).toBe(circuitBefore);
    expect(lastLog('provider credential validation recorded')).toMatchObject({
      provider: 'typesafe',
      candidateVersion: version,
      status: 'valid',
      attempts: 1,
      recorded: true,
    });
    await expectNoPlaintext();
  });

  it('records an authentication rejection as invalid without touching the breaker', async () => {
    const version = await stage('typesafe', WRONG_KEY);
    const { router, validate } = handler();
    await validate('typesafe', version);

    const record = await metadata('typesafe');
    expect(record).toMatchObject({ candidateStatus: 'invalid', lastErrorCode: 'auth_rejected' });
    expect(record.validatedAt).toBeInstanceOf(Date);
    expect(record.candidateValidation).toMatchObject({ attempts: 1, errorCode: 'auth_rejected' });
    expect(record.candidateValidation.capabilities).toBeUndefined();
    // A 401 is not retried.
    expect(jev.requests).toHaveLength(1);
    expect(jev.requests[0]?.headers['authorization']).toBe(`Bearer ${WRONG_KEY}`);
    expect(await calls()).toMatchObject([
      { status: 'auth_error', credential_version: version, kind: 'credential_probe' },
    ]);
    // The breaker mirror was never written and the router's breaker stays closed.
    expect(await circuitText()).toBeNull();
    expect((await router.status()).breakers.typesafe.state).toBe('closed');
    await expectNoPlaintext();
  });

  it('records a rejected probe request as invalid', async () => {
    jev.setOptions({ statusOverride: () => ({ status: 422 }) });
    const version = await stage('typesafe', JEV_KEY);
    await handler().validate('typesafe', version);
    expect(await metadata('typesafe')).toMatchObject({
      candidateStatus: 'invalid',
      lastErrorCode: 'request_rejected',
    });
    expect(jev.requests).toHaveLength(1);
  });

  it('stops after three attempts and leaves an unavailable provider pending', async () => {
    jev.setOptions({ failRate: 1, failStatus: 503 });
    const version = await stage('typesafe', JEV_KEY);
    await handler().validate('typesafe', version);

    const record = await metadata('typesafe');
    expect(record).toMatchObject({
      candidateStatus: 'pending',
      lastErrorCode: 'provider_unavailable',
      validatedAt: null,
    });
    expect(record.candidateValidation).toMatchObject({
      attempts: 3,
      errorCode: 'provider_unavailable',
    });
    expect(jev.requests).toHaveLength(3);
    // One audit row per wire attempt, linked by one logical request id.
    const rows = await calls();
    expect(rows.map((row) => [row.attempts, row.status])).toEqual([
      [1, 'error'],
      [2, 'error'],
      [3, 'error'],
    ]);
    expect(new Set(rows.map((row) => row.logical_request_id)).size).toBe(1);
    const reserved = await reservations();
    expect(reserved).toHaveLength(3);
    expect(reserved.reduce((sum, row) => sum + row.reserved_usd, 0)).toBeLessThanOrEqual(
      MAX_PROBE_SPEND_USD,
    );
    expect(await circuitText()).toBeNull();
  });

  it('defers a long Retry-After instead of holding the lease', async () => {
    jev.setOptions({
      statusOverride: () => ({ status: 429, headers: { 'retry-after': '120' } }),
    });
    const version = await stage('typesafe', JEV_KEY);
    await handler().validate('typesafe', version);
    expect(await metadata('typesafe')).toMatchObject({
      candidateStatus: 'pending',
      lastErrorCode: 'rate_limited',
    });
    expect(jev.requests).toHaveLength(1);
  });

  it('retries one invalid response, then records the candidate invalid', async () => {
    jev.setOptions({ statusOverride: () => ({ status: 200, body: 'not json' }) });
    const version = await stage('typesafe', JEV_KEY);
    await handler().validate('typesafe', version);
    const record = await metadata('typesafe');
    expect(record).toMatchObject({ candidateStatus: 'invalid', lastErrorCode: 'invalid_response' });
    expect(record.candidateValidation).toMatchObject({ attempts: 2 });
    expect(jev.requests).toHaveLength(2);
  });

  it('keeps one validation action within $0.02 of reserved spend', async () => {
    // A price at which one attempt reserves $0.012: a second one would exceed the bound.
    const tokens = conservativeRequestTokens(PROBE_STATE, TYPESAFE_PROBE_QUESTIONS);
    const price = (0.012 * 1_000_000) / tokens;
    expect(typesafeCostUsd(tokens, price)).toBeCloseTo(0.012, 10);
    jev.setOptions({ failRate: 1 });
    const version = await stage('typesafe', JEV_KEY);
    await handler({ config: { typesafePricePerMtokUsd: price } }).validate('typesafe', version);

    const record = await metadata('typesafe');
    expect(record).toMatchObject({
      candidateStatus: 'pending',
      lastErrorCode: 'probe_budget_exceeded',
    });
    expect(record.candidateValidation).toMatchObject({ attempts: 1 });
    expect(jev.requests).toHaveLength(1);
    const reserved = await reservations();
    expect(reserved).toHaveLength(1);
    expect(reserved[0]?.reserved_usd).toBeCloseTo(0.012, 6);
  });

  it('leaves the candidate pending when the platform budget refuses the probe', async () => {
    const version = await stage('typesafe', JEV_KEY);
    await handler({ config: { dailyBudgetUsd: 0 } }).validate('typesafe', version);
    const record = await metadata('typesafe');
    expect(record).toMatchObject({
      candidateStatus: 'pending',
      lastErrorCode: 'budget_unavailable',
    });
    expect(record.candidateValidation).toMatchObject({ attempts: 0 });
    // Nothing was sent or reserved.
    expect(jev.requests).toHaveLength(0);
    expect(await reservations()).toEqual([]);
    expect(await calls()).toEqual([]);
  });

  it('validates an Ollama candidate with one tiny chat capped at 512 output tokens', async () => {
    const version = await stage('ollama', OLLAMA_KEY);
    await handler().validate('ollama', version);

    const record = await metadata('ollama');
    expect(record).toMatchObject({ candidateStatus: 'valid', lastErrorCode: null });
    expect(record.candidateValidation).toMatchObject({
      configFingerprint: providerConfigFingerprint('ollama', testConfig()),
      model: 'glm-5.3-flash',
      attempts: 1,
      capabilities: { chat: true, json_answers: true },
    });
    expect(ollama.requests).toHaveLength(1);
    const [request] = ollama.requests;
    expect(request?.headers['authorization']).toBe(`Bearer ${OLLAMA_KEY}`);
    const body = request?.body as {
      model: string;
      options: { num_predict: number };
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe('glm-5.3-flash');
    expect(body.options.num_predict).toBe(PROBE_MAX_OUTPUT_TOKENS);
    const user = body.messages.find((message) => message.role === 'user');
    expect(JSON.parse(user?.content ?? '{}')).toMatchObject({ state: PROBE_STATE });
    expect(await calls()).toMatchObject([
      {
        engine: 'llm',
        kind: 'credential_probe',
        model: 'glm-5.3-flash',
        status: 'ok',
        credential_version: version,
      },
    ]);
    // The Jev candidate slot and server are untouched.
    expect(jev.requests).toHaveLength(0);
    await expectNoPlaintext();
  });

  it('does not resurrect a candidate revoked while its probe was in flight', async () => {
    const version = await stage('typesafe', JEV_KEY);
    const real = realJev();
    const revokeDuringCall: DecisionEngine = {
      name: 'typesafe',
      async ask(request, signal, auth) {
        const attempt = await real.ask(request, signal, auth);
        const revision = (await metadata('typesafe')).revision;
        await setProviderCredentialEnabled(db, {
          provider: 'typesafe',
          expectedRevision: revision,
          enabled: false,
        });
        return attempt;
      },
    };
    await handler({ engines: { typesafe: revokeDuringCall } }).validate('typesafe', version);

    // The tombstone stays; the successful in-flight call is still recorded and billed.
    expect(await metadata('typesafe')).toMatchObject({
      enabled: false,
      activeVersion: null,
      candidateVersion: null,
      candidateStatus: null,
    });
    expect(await calls()).toMatchObject([{ status: 'ok', credential_version: version }]);
    expect(await reservations()).toMatchObject([{ status: 'settled' }]);
    expect(lastLog('provider validation result discarded: the lease was lost')).toMatchObject({
      status: 'valid',
      recorded: false,
    });
  });

  it('stops without a result when the lease is lost between attempts', async () => {
    jev.setOptions({ failRate: 1 });
    const first = await stage('typesafe', JEV_KEY);
    let second: string | undefined;
    const real = realJev();
    const restageAfterCall: DecisionEngine = {
      name: 'typesafe',
      async ask(request, signal, auth) {
        const attempt = await real.ask(request, signal, auth);
        // An admin stages a replacement while the first attempt's backoff runs.
        second ??= await stage('typesafe', WRONG_KEY);
        return attempt;
      },
    };
    await handler({ engines: { typesafe: restageAfterCall } }).validate('typesafe', first);

    expect(jev.requests).toHaveLength(1);
    expect(await calls()).toMatchObject([{ attempts: 1, credential_version: first }]);
    expect(await reservations()).toHaveLength(1);
    // The replacement stays pending and untouched by the stale validation.
    expect(await metadata('typesafe')).toMatchObject({
      candidateVersion: second,
      candidateStatus: 'pending',
      lastErrorCode: null,
    });
    expect(lastLog('provider validation stopped: the lease was lost')).toMatchObject({
      candidateVersion: first,
    });
  });

  it('skips a candidate that is being validated elsewhere', async () => {
    const version = await stage('typesafe', JEV_KEY);
    const lease = await claimCredentialValidation(db, {
      provider: 'typesafe',
      candidateVersion: version,
      leaseMs: 60_000,
    });
    expect(lease).not.toBeNull();
    await handler().validate('typesafe', version);
    expect(jev.requests).toHaveLength(0);
    expect(await metadata('typesafe')).toMatchObject({ candidateStatus: 'validating' });
    expect(
      lastLog(
        'provider validation skipped: the candidate was replaced, revoked or is being validated',
      ),
    ).toMatchObject({ provider: 'typesafe', candidateVersion: version });
  });

  it("fails closed on this host's keyring: missing is pending, undecryptable is invalid", async () => {
    const version = await stage('typesafe', JEV_KEY);
    await handler({ credentials: resolver(null) }).validate('typesafe', version);
    expect(await metadata('typesafe')).toMatchObject({
      candidateStatus: 'pending',
      lastErrorCode: 'keyring_unavailable',
    });

    // The same key id with other key material cannot open the envelope.
    await handler({ credentials: resolver(JSON.stringify({ k1: K2 })) }).validate(
      'typesafe',
      version,
    );
    expect(await metadata('typesafe')).toMatchObject({
      candidateStatus: 'invalid',
      lastErrorCode: 'decrypt_failed',
    });
    // Neither the environment key nor any other key was sent.
    expect(jev.requests).toHaveLength(0);
    expect(await reservations()).toEqual([]);
    await expectNoPlaintext();
  });

  it('leaves validations pending when the probe of a provider is not configured', async () => {
    const version = await stage('ollama', OLLAMA_KEY);
    await handler({ probeConfig: { ollamaModelFast: 'unpriced-model' } }).validate(
      'ollama',
      version,
    );
    expect(await metadata('ollama')).toMatchObject({
      candidateStatus: 'pending',
      lastErrorCode: 'not_configured',
    });
    expect(ollama.requests).toHaveLength(0);
    expect(lastLog('provider probe is not configured; validations stay pending')).toMatchObject({
      provider: 'ollama',
    });
  });
});
