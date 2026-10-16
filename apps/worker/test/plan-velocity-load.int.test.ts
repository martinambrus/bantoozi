import {
  createDatabase,
  createPgOriginLimiter,
  MIGRATIONS_FOLDER,
  PG_BOSS_VERSION,
  runMigrations,
} from '@bantoozi/db';
import {
  createSubscription,
  createUser,
  setupTestDatabase,
  startFixtureServer,
  dropCreatedTestDatabases,
  type TestDatabase,
  type FixtureServer,
} from '@bantoozi/testing';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createWorkerDeps } from '../src/handlers/deps.js';
import { createHandlers, dispatch, type HandlerMap } from '../src/handlers/index.js';

let testDb: TestDatabase;
let owner: pg.Pool;
let server: FixtureServer;
const pools: pg.Pool[] = [];
const maps: HandlerMap[] = [];
const starts: number[] = [];
const feedIds: string[] = [];

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
  server = await startFixtureServer();
  server.route('/robots.txt', { status: 404, body: '' });
  const user = await createUser(owner, { plan: 'premium' });
  for (let index = 0; index < 100; index += 1) {
    const path = `/burst/${index}.rss`;
    server.route(path, () => {
      starts.push(Date.now());
      return {
        status: 200,
        headers: { 'content-type': 'application/rss+xml' },
        body: '<rss version="2.0"><channel><title>Burst</title><link>https://example.test</link><description>Fixture</description></channel></rss>',
      };
    });
    const result = await owner.query<{ id: string }>(
      'INSERT INTO feeds (url, fetch_url, fetch_interval_s) VALUES ($1, $1, 60) RETURNING id::text',
      [server.url(path)],
    );
    const feedId = result.rows[0]!.id;
    feedIds.push(feedId);
    await createSubscription(owner, { userId: user.id, feedId });
  }
  await owner.query('SELECT refresh_feed_subscribers($1::bigint[])', [feedIds]);
  for (let process = 0; process < 2; process += 1) {
    const query = new pg.Pool({ connectionString: testDb.urls.worker, max: 6 });
    const locks = new pg.Pool({ connectionString: testDb.urls.worker, max: 4 });
    pools.push(query, locks);
    const db = createDatabase(query);
    maps.push(
      createHandlers(
        createWorkerDeps({
          db,
          lockPool: locks,
          limiter: createPgOriginLimiter(db),
          fetch: {
            userAgent: 'BantooziBot/1.0 (+https://bantoozi.test/bot)',
            timeoutMs: 10000,
            maxBytes: 5242880,
            allowPrivate: true,
          },
          ingestMaxAgeDays: 14,
          settingsEnv: {
            dailyBudgetUsd: 2,
            languageModes: { en: 'native', sk: 'native', cs: 'native' },
            signupMode: 'invite',
          },
          logger: { info() {}, warn() {}, error() {} },
        }),
      ),
    );
  }
});

afterAll(async () => {
  await server?.close();
  await Promise.all(pools.map((pool) => pool.end()));
  await owner?.end();
  await dropCreatedTestDatabases();
});

it('schedules 100 one-minute feeds and drains two workers without exceeding the source budget', async () => {
  const started = Date.now();
  await dispatch(
    maps[0]!,
    'feed.schedule',
    {},
    { queue: 'feed.schedule', jobId: 'burst-schedule' },
  );
  const intents = await owner.query<{ payload: { feedId: string } }>(
    "SELECT payload FROM job_outbox WHERE queue = 'feed.fetch' AND delivered_at IS NULL",
  );
  expect(intents.rows).toHaveLength(100);
  await Promise.all(
    intents.rows.map((row, index) =>
      dispatch(maps[index % 2]!, 'feed.fetch', row.payload, {
        queue: 'feed.fetch',
        jobId: `burst-${index}`,
      }),
    ),
  );
  const elapsed = Date.now() - started;
  expect(starts.length).toBeGreaterThanOrEqual(1);
  expect(starts.length).toBeLessThanOrEqual(Math.floor(elapsed / 10000) + 1);
  for (let index = 1; index < starts.length; index += 1)
    expect(starts[index]! - starts[index - 1]!).toBeGreaterThanOrEqual(9990);
  const result = await owner.query<{ healthy: number; deferred: number; fetched: number }>(
    `SELECT count(*) FILTER (WHERE status = 'active' AND consecutive_errors = 0 AND next_fetch_at > now())::int AS healthy, count(*) FILTER (WHERE total_fetches = 0)::int AS deferred, sum(total_fetches)::int AS fetched FROM feeds WHERE id = ANY($1::bigint[])`,
    [feedIds],
  );
  expect(result.rows[0]).toEqual({
    healthy: 100,
    deferred: 100 - starts.length,
    fetched: starts.length,
  });
  console.info(
    `P5: 100 due Premium feeds, two worker pools, ${starts.length} HTTP fetches, ${100 - starts.length} source deferrals, ${elapsed} ms`,
  );
});
