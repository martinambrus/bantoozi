import { createDatabase, MIGRATIONS_FOLDER, PG_BOSS_VERSION, runMigrations } from '@bantoozi/db';
import {
  JEV_FAKE_MODEL,
  typesafeRequestBody,
  type EngineOutcome,
  type EngineRequest,
  type EngineRouter,
  type Question,
} from '@bantoozi/engine';
import type { EngineCircuit, InferenceAuthorization } from '@bantoozi/shared';
import {
  createArticle,
  createFeed,
  createSubscription,
  createUser,
  dropCreatedTestDatabases,
  fakeTypeSafeRoll,
  setupTestDatabase,
  startFakeTypeSafe,
  type FakeTypeSafeServer,
  type TestDatabase,
} from '@bantoozi/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createWorkerCredentialResolver } from '../src/credentials/index.js';
import { createWorkerEngineRouter, type WorkerEngineConfig } from '../src/engine-router.js';

/**
 * Spec 04 §10 "Integration test engine-breaker.int.test.ts": the worker's real router (the
 * PostgreSQL engine store, the shared breaker state in `settings['engine.circuit']`, the worker
 * credential resolver with a bootstrap key and the real TypeSafe adapter) against the fake
 * TypeSafe server, under fake timers:
 * - the fake fails every attempt of 30 % of logical calls (`failRate: 0.3`, 503);
 * - 40 calls go through the router: the breaker opens, the next calls return `circuit_open`
 *   without reaching the server (its request counter is asserted), and the mirror shows `open`;
 * - with `failRate` 0, once the open duration has elapsed the half-open probe succeeds and closes;
 * - a `resetRequested` closes an auth-mode breaker within one polling interval (10 s).
 */

const API_KEY = 'breaker-test-bootstrap-key';
/** Fake time advanced per step while a call is driven; real I/O runs between steps. */
const STEP_MS = 50;
const POLL_MS = 10_000;
const OPEN_MS = 2 * 60_000;

// Captured before fake timers are installed: a real pause lets Postgres and HTTP make progress.
const realSetTimeout = globalThis.setTimeout;
const realPause = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms));

const QUESTIONS: Record<string, Question> = {
  energy: { type: 'noul', instructions: { interest: 'Solar and wind energy' } },
  topic: {
    type: 'choice',
    instructions: 'Main topic',
    criteria: { energy: 'Energy and power grids', sport: 'Sport' },
  },
  depth: { type: 'score', instructions: 'Depth', criteria: ['brief', 'standard', 'in depth'] },
};

let testDb: TestDatabase;
let owner: pg.Pool;
let workerPool: pg.Pool;
let fake: FakeTypeSafeServer;
let authorization: InferenceAuthorization;
let articleId: string;
let articleRevision: string;

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
  workerPool = new pg.Pool({ connectionString: testDb.urls.worker, max: 6 });
  fake = await startFakeTypeSafe({ apiKey: API_KEY });

  // One reader whose active feed carried the article after activation: live automatic demand.
  const feed = await createFeed(owner);
  const user = await createUser(owner);
  await createSubscription(owner, {
    userId: user.id,
    feedId: feed.id,
    mode: 'active',
    activatedAt: new Date(Date.now() - 3_600_000),
  });
  const article = await createArticle(owner, { feedIds: [feed.id] });
  articleId = article.id;
  articleRevision = article.contentRevision;
  authorization = {
    type: 'article',
    articleId,
    articleRevision,
    witnesses: [{ kind: 'automatic', userId: user.id, feedId: feed.id, inferenceVersion: '1' }],
  };
});

afterAll(async () => {
  vi.useRealTimers();
  await fake?.close();
  await Promise.all([owner?.end(), workerPool?.end()]);
  await dropCreatedTestDatabases();
});

const config: WorkerEngineConfig = {
  nodeEnv: 'test',
  typesafeBaseUrl: '',
  typesafeModel: JEV_FAKE_MODEL,
  typesafePricePerMtokUsd: 0.042,
  engineConcurrency: 8,
  dailyBudgetUsd: 100,
  ollamaBaseUrl: 'http://127.0.0.1:9',
  ollamaModelFast: 'glm-5.3-flash',
  ollamaModelStrong: 'glm-5.3',
  ollamaMaxConcurrency: 1,
  llmFallbackEnabled: false,
};

interface LogEntry {
  level: string;
  msg: string;
  obj: object;
}

/** One worker process: its own pool, resolver (bootstrap key only) and router. */
function workerRouter(logs: LogEntry[]): EngineRouter {
  const db = createDatabase(workerPool);
  const log = (level: string) => (obj: object, msg: string) => logs.push({ level, obj, msg });
  const logger = { info: log('info'), warn: log('warn'), error: log('error') };
  return createWorkerEngineRouter({
    db,
    config: { ...config, typesafeBaseUrl: fake.url },
    credentials: createWorkerCredentialResolver({
      db,
      masterKeyId: undefined,
      masterKeys: undefined,
      envKeys: { typesafe: API_KEY },
      logger,
    }),
    logger,
    // Deterministic retry schedule: 500, 1000 and 2000 ms before attempts 2–4.
    random: () => 0.5,
  });
}

/** A logical call with its own body, so the fake's failure roll differs per call. */
function call(i: number): EngineRequest {
  return {
    kind: 'enrich',
    state: {
      article: {
        title: `Grid storage report number ${i}`,
        excerpt: `Batteries and solar farms, synthetic item ${i}.`,
      },
    },
    questions: QUESTIONS,
    questionSetSha: 'a'.repeat(64),
    stateSha256: i.toString(16).padStart(64, '0'),
    articleId,
    articleRevision,
    priority: 'bulk',
    authorization,
  };
}

/** Whether the fake fails every attempt of this logical call (spec 04 §10: `sha256(body)`). */
const failsAt = (req: EngineRequest, failRate: number) =>
  fakeTypeSafeRoll(JSON.stringify(typesafeRequestBody(JEV_FAKE_MODEL, req))) < failRate;

/**
 * Drive one router call under fake timers: real pauses let Postgres and the fake server respond,
 * and fake time advances in small steps so backoff sleeps elapse (an attempt's 30 s timeout never
 * does: a call's real I/O takes only a few steps).
 */
async function drive<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let i = 0; i < 20_000 && !settled; i += 1) {
    await realPause(1);
    if (!settled) await vi.advanceTimersByTimeAsync(STEP_MS);
  }
  return promise;
}

async function circuitMirror(): Promise<EngineCircuit> {
  const { rows } = await owner.query<{ value: EngineCircuit }>(
    `SELECT value FROM settings WHERE key = 'engine.circuit'`,
  );
  if (rows[0] === undefined) throw new Error('engine.circuit is missing');
  return rows[0].value;
}

/** The first call at which the rolling window (≥ 20 logical calls, > 20 % failed) trips. */
function openingIndex(fails: readonly boolean[]): number {
  let failures = 0;
  for (let i = 0; i < fails.length; i += 1) {
    if (!fails[i]) continue;
    failures += 1;
    if (i + 1 >= 20 && failures / (i + 1) > 0.2) return i;
  }
  return -1;
}

describe('engine breaker against the fake TypeSafe server (spec 04 §10)', () => {
  it('opens on failing logical calls, stops calling the server, probes closed and resets auth mode', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: Date.now() });
    const logs: LogEntry[] = [];
    const router = workerRouter(logs);
    fake.setOptions({ failRate: 0.3, failStatus: 503 });

    const calls = Array.from({ length: 40 }, (_, i) => call(i));
    const fails = calls.map((req) => failsAt(req, 0.3));
    const opening = openingIndex(fails);
    // The deterministic rolls open the breaker well within the 40 calls.
    expect(opening).toBeGreaterThanOrEqual(19);
    expect(opening).toBeLessThan(35);

    const results: Array<{ outcome: EngineOutcome; sent: number }> = [];
    for (const req of calls) {
      const before = fake.requestCount();
      const outcome = await drive(router.ask(req));
      results.push({ outcome, sent: fake.requestCount() - before });
    }

    // Until the breaker opened, every call reached the server: failing ones on every attempt.
    for (let i = 0; i <= opening; i += 1) {
      const { outcome, sent } = results[i]!;
      if (fails[i]) {
        expect(outcome).toMatchObject({ ok: false, reason: 'error' });
        expect(outcome.ok === false && outcome.retryAt).toBeFalsy();
        expect(sent).toBe(4);
      } else {
        expect(outcome).toMatchObject({ ok: true, engine: 'typesafe', model: JEV_FAKE_MODEL });
        expect(sent).toBe(1);
      }
    }
    // Afterwards: circuit_open, and the fake's request counter does not move.
    const later = results.slice(opening + 1);
    expect(later.length).toBeGreaterThan(0);
    for (const { outcome, sent } of later) {
      expect(outcome).toMatchObject({ ok: false, reason: 'circuit_open', detail: 'typesafe:open' });
      expect(outcome.ok === false && outcome.retryAt).toBeInstanceOf(Date);
      expect(sent).toBe(0);
    }
    const opened = await circuitMirror();
    expect(opened.typesafe).toMatchObject({ state: 'open', reopenCount: 0 });
    expect(Date.parse(opened.typesafe.openUntil!) - Date.parse(opened.typesafe.openedAt!)).toBe(
      OPEN_MS,
    );
    expect(opened.llm).toEqual({ state: 'closed', reopenCount: 0 });
    expect(logs).toContainEqual(expect.objectContaining({ msg: 'engine breaker opened' }));

    // A second worker process shares the state: it is denied without reaching the server too.
    const otherWorker = workerRouter([]);
    const counted = fake.requestCount();
    expect(await drive(otherWorker.ask(call(100)))).toMatchObject({ reason: 'circuit_open' });
    expect(fake.requestCount()).toBe(counted);

    // One attempt row per wire attempt, linked by the logical request id.
    const { rows: attempts } = await owner.query<{ calls: number; attempts: number[] }>(
      `SELECT count(*)::int AS calls, array_agg(attempts ORDER BY attempts) AS attempts
         FROM engine_calls WHERE engine = 'typesafe' AND status = 'error'
        GROUP BY logical_request_id`,
    );
    expect(attempts).toHaveLength(fails.slice(0, opening + 1).filter(Boolean).length);
    for (const row of attempts) expect(row.attempts).toEqual([1, 2, 3, 4]);

    // Recovery: the provider is healthy again and the open duration elapses.
    fake.setOptions({ failRate: 0 });
    await vi.advanceTimersByTimeAsync(OPEN_MS);
    const failedBody = calls[fails.indexOf(true)]!;
    const probeBefore = fake.requestCount();
    const probe = await drive(router.ask(failedBody));
    expect(probe).toMatchObject({ ok: true, engine: 'typesafe' });
    expect(fake.requestCount() - probeBefore).toBe(1);
    expect((await circuitMirror()).typesafe).toEqual({ state: 'closed', reopenCount: 0 });
    expect(logs).toContainEqual(
      expect.objectContaining({ msg: 'engine breaker half-open probe acquired' }),
    );

    // Auth mode: a 401 of the active (bootstrap) key opens auth mode until an explicit reset.
    fake.setOptions({ statusOverride: () => ({ status: 401 }) });
    expect(await drive(router.ask(call(200)))).toMatchObject({ ok: false, reason: 'error' });
    expect((await circuitMirror()).typesafe.state).toBe('auth');
    fake.setOptions({ statusOverride: undefined });
    const authBefore = fake.requestCount();
    expect(await drive(router.ask(call(201)))).toMatchObject({
      ok: false,
      reason: 'circuit_open',
      detail: 'typesafe:auth',
    });
    expect(fake.requestCount()).toBe(authBefore);
    // Auth mode never expires by itself…
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(await drive(router.ask(call(202)))).toMatchObject({ reason: 'circuit_open' });

    // …an admin reset request (spec 08) closes it within one polling interval.
    await owner.query(
      `UPDATE settings
          SET value = jsonb_set(value, '{resetRequested,typesafe}', to_jsonb($1::text))
        WHERE key = 'engine.circuit'`,
      [new Date().toISOString()],
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    const reset = await drive(router.ask(call(203)));
    expect(reset).toMatchObject({ ok: true, engine: 'typesafe' });
    expect((await circuitMirror()).typesafe).toEqual({ state: 'closed', reopenCount: 0 });
    expect(logs).toContainEqual(expect.objectContaining({ msg: 'engine breaker reset' }));
    vi.useRealTimers();
  });
});
