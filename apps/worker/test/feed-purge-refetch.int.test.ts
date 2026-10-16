import {
  MIGRATIONS_FOLDER,
  PG_BOSS_VERSION,
  createDatabase,
  runMigrations,
  type Database,
} from '@bantoozi/db';
import { createMemoryOriginLimiter } from '@bantoozi/feeds';
import {
  createSubscription,
  createUser,
  dropCreatedTestDatabases,
  setupTestDatabase,
  startFixtureServer,
  type FixtureServer,
  type TestDatabase,
  type UserFixture,
} from '@bantoozi/testing';
import { parseJobPayload } from '@bantoozi/shared';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createWorkerDeps } from '../src/handlers/deps.js';
import { createHandlers, dispatch, type HandlerMap } from '../src/handlers/index.js';

/**
 * D-253 (retention), end to end: an article the 21-day rule purged after it left its feed is not
 * ingested again when the feed is fetched once more without it, and an article the feed still lists
 * is never purged by that rule, however old its first sighting. Real clock, the handlers through the
 * registered map, effects read from the database only.
 */

const DAY = 86_400_000;
const silent = { info: () => {}, warn: () => {}, error: () => {} };

let testDb: TestDatabase;
let owner: pg.Pool;
let workerPool: pg.Pool;
let lockPool: pg.Pool;
let db: Database;
let server: FixtureServer;
let handlers: HandlerMap;
let reader: UserFixture;

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
  handlers = createHandlers(
    createWorkerDeps({
      db,
      lockPool,
      fetch: {
        userAgent: 'BantooziBot/1.0 (+https://bantoozi.test/bot)',
        timeoutMs: 10_000,
        maxBytes: 5 * 1024 * 1024,
        allowPrivate: true,
      },
      ingestMaxAgeDays: 14,
      settingsEnv: {
        dailyBudgetUsd: 2,
        languageModes: { en: 'native', sk: 'native', cs: 'native' },
        signupMode: 'invite',
      },
      limiter: createMemoryOriginLimiter({ spacingMs: 0 }),
      logger: silent,
    }),
  );
  reader = await createUser(owner);
}, 240_000);

afterAll(async () => {
  await server?.close();
  await Promise.all([owner?.end(), workerPool?.end(), lockPool?.end()]);
  await dropCreatedTestDatabases();
});

function rss(guids: readonly string[]): string {
  const items = guids
    .map(
      (g) => `<item><title>Item ${g}</title><link>${server.url(`/ls/${g}.html`)}</link>
<guid>${g}</guid><pubDate>${new Date(Date.now() - DAY).toUTCString()}</pubDate>
<description>Item ${g}: the summary from the feed.</description></item>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>Last seen</title><link>${server.url('/')}</link>
<description>Last seen</description>${items}</channel></rss>`;
}

async function addFeed(path: string): Promise<string> {
  const url = server.url(path);
  const result = await owner.query<{ id: string }>(
    'INSERT INTO feeds (url, fetch_url) VALUES ($1, $1) RETURNING id::text AS id',
    [url],
  );
  const feedId = result.rows[0]!.id;
  await createSubscription(owner, { userId: reader.id, feedId, mode: 'off' });
  return feedId;
}

async function fetchFeed(feedId: string): Promise<void> {
  await dispatch(
    handlers,
    'feed.fetch',
    { feedId, force: true },
    { queue: 'feed.fetch', jobId: 'ls' },
  );
}

describe('purge then refetch (D-253)', () => {
  it('does not bring a purged article back, and never purges one the feed still lists', async () => {
    let guids = ['pr-gone', 'pr-listed'];
    server.route('/ls/purge.rss', () => ({
      status: 200,
      headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
      body: rss(guids),
    }));
    const feedId = await addFeed('/ls/purge.rss');
    await fetchFeed(feedId);
    const articleOf = async (guid: string): Promise<string | undefined> =>
      (
        await owner.query<{ id: string }>(
          `SELECT article_id::text AS id FROM feed_items WHERE feed_id = $1 AND guid = $2`,
          [feedId, guid],
        )
      ).rows[0]?.id;
    const gone = await articleOf('pr-gone');
    const listed = await articleOf('pr-listed');
    expect(gone).toBeDefined();
    expect(listed).toBeDefined();

    // Both were first seen 40 days ago; then the feed drops one of them and is fetched again.
    const old = new Date(Date.now() - 40 * DAY);
    await owner.query(`UPDATE articles SET first_seen_at = $2 WHERE id = ANY($1::bigint[])`, [
      [gone, listed],
      old,
    ]);
    await owner.query(
      `UPDATE feed_items SET first_seen_at = $2, last_seen_at = $2 WHERE feed_id = $1`,
      [feedId, old],
    );
    guids = ['pr-listed'];
    await fetchFeed(feedId);

    await dispatch(handlers, 'house.purge-articles', parseJobPayload('house.purge-articles', {}), {
      queue: 'house.purge-articles',
      jobId: 'purge',
    });
    const exists = async (id: string | undefined): Promise<boolean> =>
      (await owner.query(`SELECT 1 FROM articles WHERE id = $1`, [id])).rowCount === 1;
    expect(await exists(gone)).toBe(false);
    expect(await exists(listed)).toBe(true);

    await fetchFeed(feedId);
    const titles = await owner.query<{ title: string }>(
      `SELECT a.title FROM feed_items fi JOIN articles a ON a.id = fi.article_id WHERE fi.feed_id = $1`,
      [feedId],
    );
    expect(titles.rows.map((row) => row.title)).toEqual(['Item pr-listed']);
  });
});
