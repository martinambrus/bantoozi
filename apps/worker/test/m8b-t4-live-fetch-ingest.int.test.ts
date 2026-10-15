import {
  MIGRATIONS_FOLDER,
  PG_BOSS_VERSION,
  createDatabase,
  createRuntimeSettingsCache,
  runMigrations,
  runtimeSettingsLoader,
  type Database,
  type RuntimeSettingsCache,
} from '@bantoozi/db';
import { createMemoryOriginLimiter } from '@bantoozi/feeds';
import type { RuntimeEnvDefaults, RuntimeSettingsContext } from '@bantoozi/shared';
import {
  createSubscription,
  createUser,
  dropCreatedTestDatabases,
  setupTestDatabase,
  startFixtureServer,
  type FixtureServer,
  type TestDatabase,
} from '@bantoozi/testing';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createWorkerDeps, fetchWith, type WorkerDeps } from '../src/handlers/deps.js';
import { createHandlers, dispatch } from '../src/handlers/index.js';

/**
 * M8b-T4 class L (scope B2): stored `fetch.limits` and `ingest.max_age_days` apply within the cache
 * TTL, without a restart, through the real worker deps.
 *
 * Seam chosen by this ruler: `createWorkerDeps({ ..., runtimeSettings })` takes the T1
 * `RuntimeSettingsCache`. When present, `fetchWith` reads `fetchLimits` from `await cache.get()` on
 * every call (timeout = min(caller's, setting), maxBytes = setting) and `feed.fetch` reads
 * `ingestMaxAgeDays` once per job. The static `fetch.timeoutMs/maxBytes` and `ingestMaxAgeDays` stay
 * as the fallback when no cache is given (every existing test).
 */
const DAY = 86_400_000;
const TTL = 10_000;
const ENV: RuntimeEnvDefaults = {
  typesafeModel: 'jev-fake',
  typesafeBaseUrl: 'http://127.0.0.1:1',
  typesafePricePerMtokUsd: 0.042,
  engineConcurrency: 8,
  llmFallbackEnabled: false,
  ollamaModelFast: 'glm-5.3-flash',
  ollamaModelStrong: 'glm-5.3',
  ollamaBaseUrl: 'http://127.0.0.1:2',
  ollamaMaxConcurrency: 1,
  prefilterMinCards: 60,
  autoAnalysisDailyCap: 1000,
  ingestMaxAgeDays: 14,
  fetchTimeoutMs: 10_000,
  fetchMaxBytes: 5 * 1024 * 1024,
  rateLimitsEnabled: true,
  libretranslateUrl: 'http://127.0.0.1:3',
};
const CTX: RuntimeSettingsContext = {
  production: false,
  providerHostAllowlist: [],
  ollamaPricedModels: ['glm-5.3-flash', 'glm-5.3'],
};
const silent = { info: () => {}, warn: () => {}, error: () => {} };

let testDb: TestDatabase;
let owner: pg.Pool;
let workerPool: pg.Pool;
let lockPool: pg.Pool;
let db: Database;
let server: FixtureServer;
let clock = 1_000_000;
let cache: RuntimeSettingsCache;
let deps: WorkerDeps;

beforeAll(async () => {
  testDb = await setupTestDatabase({
    pkg: 'worker',
    migrationsDir: MIGRATIONS_FOLDER,
    pgBossVersion: PG_BOSS_VERSION,
    migrate: async (url) => {
      await runMigrations({ databaseUrl: url });
    },
  });
  owner = new pg.Pool({ connectionString: testDb.urls.owner, max: 3 });
  workerPool = new pg.Pool({ connectionString: testDb.urls.worker, max: 6 });
  lockPool = new pg.Pool({ connectionString: testDb.urls.worker, max: 2 });
  db = createDatabase(workerPool);
  server = await startFixtureServer();
  cache = createRuntimeSettingsCache({
    load: runtimeSettingsLoader(db),
    env: ENV,
    context: CTX,
    ttlMs: TTL,
    now: () => clock,
  });
  deps = createWorkerDeps({
    db,
    lockPool,
    fetch: {
      userAgent: 'BantooziBot/1.0 (+https://bantoozi.test/bot)',
      timeoutMs: ENV.fetchTimeoutMs,
      maxBytes: ENV.fetchMaxBytes,
      allowPrivate: true,
    },
    ingestMaxAgeDays: ENV.ingestMaxAgeDays,
    settingsEnv: {
      dailyBudgetUsd: 2,
      languageModes: { en: 'native', sk: 'native', cs: 'native' },
      signupMode: 'invite',
    },
    limiter: createMemoryOriginLimiter({ spacingMs: 0 }),
    logger: silent,
    runtimeSettings: cache,
  } as Parameters<typeof createWorkerDeps>[0]);
}, 240_000);

afterAll(async () => {
  await server?.close();
  await Promise.all([owner?.end(), workerPool?.end(), lockPool?.end()]);
  await dropCreatedTestDatabases();
});

beforeEach(async () => {
  await owner.query(`DELETE FROM settings WHERE key IN ('fetch.limits','ingest.max_age_days')`);
  clock += 10 * TTL; // every test starts with an expired snapshot
});

async function store(key: string, value: unknown): Promise<void> {
  await owner.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

describe('stored fetch.limits change what safeFetch receives', () => {
  beforeAll(() => {
    server.route('/big.xml', {
      status: 200,
      headers: { 'content-type': 'application/xml' },
      body: `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${'<!-- pad -->'.repeat(10_000)}</channel></rss>`,
    });
    server.route('/slow.xml', {
      status: 200,
      headers: { 'content-type': 'application/xml' },
      body: '<rss version="2.0"><channel><title>t</title></channel></rss>',
      delayMs: 2_500,
    });
  });

  it('maxBytes: ok under the env default, FEED_TOO_LARGE once 65536 is stored and the TTL passed', async () => {
    const before = await fetchWith(deps, server.url('/big.xml'), { purpose: 'feed' });
    expect(before.ok).toBe(true);

    await store('fetch.limits', { timeoutMs: 10_000, maxBytes: 65_536 });
    // Negative control: inside the TTL the cached snapshot (env) still applies.
    clock += TTL / 2;
    expect((await fetchWith(deps, server.url('/big.xml'), { purpose: 'feed' })).ok).toBe(true);
    // Within the TTL after the write the new value is in force: no restart.
    clock += TTL;
    const after = await fetchWith(deps, server.url('/big.xml'), { purpose: 'feed' });
    expect(after).toMatchObject({ ok: false, code: 'FEED_TOO_LARGE' });
  });

  it('timeoutMs: a 2.5 s response succeeds at the env 10 s and times out at a stored 1 s', async () => {
    expect((await fetchWith(deps, server.url('/slow.xml'), { purpose: 'feed' })).ok).toBe(true);
    await store('fetch.limits', { timeoutMs: 1_000, maxBytes: 5 * 1024 * 1024 });
    clock += TTL + 1;
    const after = await fetchWith(deps, server.url('/slow.xml'), { purpose: 'feed' });
    expect(after).toMatchObject({ ok: false, code: 'FEED_TIMEOUT' });
  });

  it('a stored null (reset) restores the env value', async () => {
    await store('fetch.limits', { timeoutMs: 1_000, maxBytes: 65_536 });
    clock += TTL + 1;
    expect(await fetchWith(deps, server.url('/big.xml'), { purpose: 'feed' })).toMatchObject({
      ok: false,
    });
    await store('fetch.limits', null);
    clock += TTL + 1;
    expect((await fetchWith(deps, server.url('/big.xml'), { purpose: 'feed' })).ok).toBe(true);
  });
});

describe('stored ingest.max_age_days applies to the next feed.fetch', () => {
  function oldItemFeed(path: string, daysOld: number): string {
    const url = server.url(`/article-${path}`);
    server.route(path, () => ({
      status: 200,
      headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
      body: `<?xml version="1.0"?><rss version="2.0"><channel><title>Old news</title><link>${server.url('/')}</link><description>d</description>
<item><title>Item ${path}</title><link>${url}</link><guid>g-${path}</guid><pubDate>${new Date(Date.now() - daysOld * DAY).toUTCString()}</pubDate><description>Summary ${path}.</description></item>
</channel></rss>`,
    }));
    return url;
  }

  async function fetchFeedAt(path: string): Promise<string> {
    const url = server.url(path);
    const feed = await owner.query<{ id: string }>(
      'INSERT INTO feeds (url, fetch_url) VALUES ($1, $1) RETURNING id::text AS id',
      [url],
    );
    const feedId = feed.rows[0]!.id;
    const user = await createUser(owner);
    await createSubscription(owner, {
      userId: user.id,
      feedId,
      mode: 'active',
      activatedAt: new Date(Date.now() - 60_000),
    });
    await owner.query('SELECT refresh_feed_subscribers($1::bigint[], $2::jsonb)', [
      [feedId],
      JSON.stringify({ beta: 900, admin: 300 }),
    ]);
    await dispatch(
      createHandlers(deps),
      'feed.fetch',
      { feedId, force: true },
      { queue: 'feed.fetch', jobId: `t4-${path}` },
    );
    return feedId;
  }

  async function pipelineStates(feedId: string): Promise<string[]> {
    const r = await owner.query<{ pipeline_state: string }>(
      `SELECT a.pipeline_state FROM articles a JOIN feed_items fi ON fi.article_id = a.id
        WHERE fi.feed_id = $1`,
      [feedId],
    );
    return r.rows.map((x) => x.pipeline_state);
  }

  it('a 20-day-old item is stale under the env 14 days; ingested after 30 is stored', async () => {
    oldItemFeed('/age-a.rss', 20);
    const first = await fetchFeedAt('/age-a.rss');
    expect(await pipelineStates(first)).toEqual(['stale']);

    await store('ingest.max_age_days', 30);
    clock += TTL + 1;
    oldItemFeed('/age-b.rss', 20);
    const second = await fetchFeedAt('/age-b.rss');
    expect(await pipelineStates(second)).toEqual(['ingested']);
  });

  it('negative control: a stored 7 makes a 10-day-old item stale where the env 14 would not', async () => {
    oldItemFeed('/age-c.rss', 10);
    const env = await fetchFeedAt('/age-c.rss');
    expect(await pipelineStates(env)).toEqual(['ingested']);
    await store('ingest.max_age_days', 7);
    clock += TTL + 1;
    oldItemFeed('/age-d.rss', 10);
    const stored = await fetchFeedAt('/age-d.rss');
    expect(await pipelineStates(stored)).toEqual(['stale']);
  });
});
