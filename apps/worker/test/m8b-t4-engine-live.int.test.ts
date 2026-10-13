import { createDatabase, MIGRATIONS_FOLDER, PG_BOSS_VERSION, runMigrations } from '@bantoozi/db';
import {
  JEV_FAKE_MODEL,
  type EngineRequest,
  type EngineRouter,
  type Question,
} from '@bantoozi/engine';
import type { InferenceAuthorization } from '@bantoozi/shared';
import {
  createArticle,
  createFeed,
  createSubscription,
  createUser,
  dropCreatedTestDatabases,
  setupTestDatabase,
  startFakeTypeSafe,
  type FakeTypeSafeServer,
  type TestDatabase,
} from '@bantoozi/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createWorkerCredentialResolver } from '../src/credentials/index.js';
import { createWorkerEngineRouter, type WorkerEngineConfig } from '../src/engine-router.js';

/**
 * M8b-T4 class L (scope B2): the engine router applies a changed TYPESAFE price to NEW reservations
 * only, and `reconfigure({ concurrency })` resizes the engine semaphore live. Both against the fake
 * TypeSafe server, the PostgreSQL engine store and the worker credential resolver, real timers.
 *
 * Seams chosen by this ruler:
 * - Price: `engineConfigFromWorker` must read `config.typesafePricePerMtokUsd` lazily (at each
 *   estimate), so the test passes a config whose property is a getter backed by a variable. An
 *   attempt's reservation AND its settlement keep the price that was in force when it reserved.
 * - Concurrency: `EngineRouter.reconfigure({ concurrency: n })` (sync, positive integer).
 */
const API_KEY = 'm8b-t4-bootstrap-key';
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
}, 240_000);

afterAll(async () => {
  await fake?.close();
  await Promise.all([owner?.end(), workerPool?.end()]);
  await dropCreatedTestDatabases();
});

const QUESTIONS: Record<string, Question> = {
  topic: {
    type: 'choice',
    instructions: 'Main topic',
    criteria: { energy: 'Energy and power grids', sport: 'Sport' },
  },
};

function call(i: number, long = false): EngineRequest {
  return {
    kind: 'enrich',
    state: {
      article: {
        title: `Grid storage report number ${i}`,
        excerpt: long ? 'Batteries and solar farms. '.repeat(1_500) : `Synthetic item ${i}.`,
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

function makeRouter(config: WorkerEngineConfig): EngineRouter {
  const db = createDatabase(workerPool);
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
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
    random: () => 0.5,
  });
}

const BASE: WorkerEngineConfig = {
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

/**
 * `makeRouter` copies the config with a spread, which would evaluate a getter once. Define the
 * live price on the object the worker receives instead: the test passes it unspread through
 * `liveConfig`, and the spread in `makeRouter` is replaced by a prototype-preserving wrapper.
 */
function liveConfig(price: { value: number }): WorkerEngineConfig {
  const config = Object.create(null) as Record<string, unknown>;
  for (const [k, v] of Object.entries(BASE)) config[k] = v;
  Object.defineProperty(config, 'typesafePricePerMtokUsd', {
    enumerable: true,
    get: () => price.value,
  });
  return config as unknown as WorkerEngineConfig;
}

function routerWithLivePrice(price: { value: number }): EngineRouter {
  const db = createDatabase(workerPool);
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  const config = liveConfig(price);
  Object.defineProperty(config, 'typesafeBaseUrl', { enumerable: true, value: fake.url });
  return createWorkerEngineRouter({
    db,
    config,
    credentials: createWorkerCredentialResolver({
      db,
      masterKeyId: undefined,
      masterKeys: undefined,
      envKeys: { typesafe: API_KEY },
      logger,
    }),
    logger,
    random: () => 0.5,
  });
}

async function reservationsOf(ids: string[]) {
  const r = await owner.query<{ reserved: string; actual: string | null; status: string }>(
    `SELECT reserved_usd::text AS reserved, actual_usd::text AS actual, status
       FROM engine_reservations ORDER BY created_at, id`,
  );
  void ids;
  return r.rows.map((x) => ({
    reserved: Number(x.reserved),
    actual: x.actual === null ? null : Number(x.actual),
    status: x.status,
  }));
}

describe('engine.typesafe_price_per_mtok_usd applies to new reservations only', () => {
  it('doubling the price mid-flight leaves the in-flight reservation and settlement at the old price', async () => {
    await owner.query('DELETE FROM engine_reservations');
    const price = { value: 0.042 };
    const router = routerWithLivePrice(price);
    fake.setOptions({ latencyMs: 400 });
    try {
      const startRequests = fake.requestCount();
      const first = router.ask(call(1, true));
      // The first attempt is on the wire: its reservation exists with the old price.
      for (let i = 0; i < 200 && fake.requestCount() === startRequests; i += 1) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(fake.requestCount()).toBeGreaterThan(startRequests);
      price.value = 0.084;
      const firstOutcome = await first;
      expect(firstOutcome).toMatchObject({ ok: true });
      fake.setOptions({ latencyMs: 0 });
      const secondOutcome = await router.ask(call(1, true));
      expect(secondOutcome).toMatchObject({ ok: true });
    } finally {
      fake.setOptions({ latencyMs: 0 });
    }
    const rows = await reservationsOf([]);
    expect(rows).toHaveLength(2);
    const [a, b] = rows as [(typeof rows)[0], (typeof rows)[0]];
    expect(a.status).toBe('settled');
    expect(b.status).toBe('settled');
    // The new reservation uses the new price: exactly twice the in-flight one for the same body.
    expect(b.reserved / a.reserved).toBeGreaterThan(1.97);
    expect(b.reserved / a.reserved).toBeLessThan(2.03);
    // The in-flight attempt settled at the price it reserved with, not at the new one.
    expect(a.actual).not.toBeNull();
    expect(b.actual! / a.actual!).toBeGreaterThan(1.97);
    expect(b.actual! / a.actual!).toBeLessThan(2.03);
  });

  it('negative control: an unchanged price gives equal reservations for equal requests', async () => {
    await owner.query('DELETE FROM engine_reservations');
    const price = { value: 0.042 };
    const router = routerWithLivePrice(price);
    await router.ask(call(2, true));
    await router.ask(call(2, true));
    const rows = await reservationsOf([]);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.reserved).toBeCloseTo(rows[0]!.reserved, 8);
    expect(rows[1]!.actual).toBeCloseTo(rows[0]!.actual!, 8);
  });
});

type Reconfigurable = EngineRouter & { reconfigure(options: { concurrency: number }): void };

describe('router.reconfigure({ concurrency })', () => {
  const LATENCY = 250;

  async function arrivals(router: EngineRouter, n: number, midway?: () => void) {
    const times: number[] = [];
    fake.setOptions({
      latencyMs: LATENCY,
      statusOverride: () => {
        times.push(Date.now());
        return undefined;
      },
    });
    try {
      const asks = Array.from({ length: n }, (_, i) => router.ask(call(100 + i)));
      if (midway) {
        await new Promise((r) => setTimeout(r, 60));
        midway();
      }
      const outcomes = await Promise.all(asks);
      expect(outcomes.every((o) => o.ok)).toBe(true);
    } finally {
      fake.setOptions({ latencyMs: 0, statusOverride: undefined });
    }
    return times.sort((a, b) => a - b);
  }

  it('shrinking to 1 serialises the attempts: arrivals are at least a response apart', async () => {
    const router = makeRouter({ ...BASE, engineConcurrency: 4 });
    (router as Reconfigurable).reconfigure({ concurrency: 1 });
    const t = await arrivals(router, 4);
    expect(t).toHaveLength(4);
    for (let i = 1; i < t.length; i += 1)
      expect(t[i]! - t[i - 1]!).toBeGreaterThanOrEqual(LATENCY * 0.8);
  });

  it('negative control: without reconfigure a capacity of 4 sends all four at once', async () => {
    const router = makeRouter({ ...BASE, engineConcurrency: 4 });
    const t = await arrivals(router, 4);
    expect(t[3]! - t[0]!).toBeLessThan(LATENCY * 0.6);
  });

  it('growing from 1 to 4 while three attempts wait releases them before the first answer', async () => {
    const router = makeRouter({ ...BASE, engineConcurrency: 1 });
    const t = await arrivals(router, 4, () =>
      (router as Reconfigurable).reconfigure({ concurrency: 4 }),
    );
    expect(t).toHaveLength(4);
    // The first arrives at ~0; the others right after the resize at ~60 ms, well before ~250 ms.
    expect(t[3]! - t[0]!).toBeLessThan(LATENCY * 0.8);
  });

  it('refuses a capacity that is not a positive integer', () => {
    const router = makeRouter({ ...BASE, engineConcurrency: 2 });
    for (const bad of [0, 1.5, -2]) {
      expect(() => (router as Reconfigurable).reconfigure({ concurrency: bad })).toThrow(
        RangeError,
      );
    }
  });
});
