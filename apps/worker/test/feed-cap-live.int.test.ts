import {
  MIGRATIONS_FOLDER,
  PG_BOSS_VERSION,
  createDatabase,
  createRuntimeSettingsCache,
  eligibleInferenceDemand,
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

import { createWorkerDeps, type WorkerDeps } from '../src/handlers/deps.js';
import { createHandlers, dispatch } from '../src/handlers/index.js';

/**
 * D-251: the stored runtime setting `engine.auto_analysis_daily_cap` applies to the next
 * `feed.fetch` within the cache TTL, without a restart, through the real worker deps. The env
 * default (RuntimeEnvDefaults.autoAnalysisDailyCap) is 1000 here; a stored 0 admits nothing and
 * marks the arrival (`feed_items.over_cap_limit = 0`); a reset restores the env value.
 */
const TTL = 10_000;
const ENV = {
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
  ingestMaxAgeDays: 14,
  fetchTimeoutMs: 10_000,
  fetchMaxBytes: 5 * 1024 * 1024,
  rateLimitsEnabled: true,
  libretranslateUrl: 'http://127.0.0.1:3',
  autoAnalysisDailyCap: 1000,
} as RuntimeEnvDefaults;
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
  await owner.query(`DELETE FROM settings WHERE key = 'engine.auto_analysis_daily_cap'`);
  clock += 10 * TTL; // every test starts with an expired snapshot
});

async function store(key: string, value: unknown): Promise<void> {
  await owner.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

function itemFeed(path: string): void {
  const url = server.url(`/article-${path}`);
  server.route(path, () => ({
    status: 200,
    headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
    body: `<?xml version="1.0"?><rss version="2.0"><channel><title>News</title><link>${server.url('/')}</link><description>d</description>
<item><title>Item ${path}</title><link>${url}</link><guid>g-${path}</guid><pubDate>${new Date(Date.now() - 3_600_000).toUTCString()}</pubDate><description>Summary ${path}.</description></item>
</channel></rss>`,
  }));
}

/** Fetch a fresh feed with one active reader; returns the mark of its only arrival. */
async function arrivalMark(path: string): Promise<{ mark: number | null; automatic: number }> {
  itemFeed(path);
  const feed = await owner.query<{ id: string }>(
    'INSERT INTO feeds (url, fetch_url) VALUES ($1, $1) RETURNING id::text AS id',
    [server.url(path)],
  );
  const feedId = feed.rows[0]!.id;
  const user = await createUser(owner);
  await createSubscription(owner, {
    userId: user.id,
    feedId,
    mode: 'active',
    activatedAt: new Date(Date.now() - 60_000),
  });
  await owner.query('SELECT refresh_feed_subscribers($1::bigint[])', [[feedId]]);
  await dispatch(
    createHandlers(deps),
    'feed.fetch',
    { feedId, force: true },
    { queue: 'feed.fetch', jobId: `cap-${path}` },
  );
  const item = await owner.query<{ article_id: string }>(
    `SELECT article_id::text AS article_id FROM feed_items WHERE feed_id = $1`,
    [feedId],
  );
  const articleId = item.rows[0]!.article_id;
  const automatic = (await eligibleInferenceDemand(db, articleId)).filter(
    (w) => w.kind === 'automatic',
  ).length;
  const mark = await owner
    .query<{ mark: number | null }>(
      `SELECT over_cap_limit AS mark FROM feed_items WHERE feed_id = $1`,
      [feedId],
    )
    .then((r) => r.rows[0]!.mark)
    .catch(() => 'no over_cap_limit column' as unknown as number);
  return { mark, automatic };
}

describe('stored engine.auto_analysis_daily_cap applies to the next feed.fetch', () => {
  it('admits under the env default, marks the arrival after a stored 0, and resets to the env value', async () => {
    expect((await arrivalMark('/cap-a.rss')).automatic).toBe(1);

    await store('engine.auto_analysis_daily_cap', 0);
    // Negative control: inside the TTL the cached snapshot (env) still applies.
    clock += TTL / 2;
    expect((await arrivalMark('/cap-b.rss')).automatic).toBe(1);
    clock += TTL;
    const capped = await arrivalMark('/cap-c.rss');
    expect(capped.automatic).toBe(0);
    expect(capped.mark).toBe(0);

    await store('engine.auto_analysis_daily_cap', null);
    clock += TTL + 1;
    expect(await arrivalMark('/cap-d.rss')).toEqual({ mark: null, automatic: 1 });
  });
});
