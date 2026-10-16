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
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createWorkerDeps } from '../src/handlers/deps.js';
import { createHandlers, dispatch, type HandlerMap } from '../src/handlers/index.js';

/**
 * D-253 (retention): `feed_items.last_seen_at` is the clock of the "latest arrival" every purge rule
 * uses. `feed.fetch` bumps it whenever an already-known item appears again in the parsed feed, and a
 * 304 Not Modified counts as "everything seen in the last successful fetch is still present".
 * Real clock, the handler through the registered map, effects read from the database only.
 */

const DAY = 86_400_000;
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
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

interface ItemRow {
  guid: string;
  first: Date;
  last: Date;
}

async function items(feedId: string): Promise<Map<string, ItemRow>> {
  const result = await owner.query<{ guid: string; first: Date; last: Date }>(
    `SELECT guid, first_seen_at AS first, last_seen_at AS last FROM feed_items WHERE feed_id = $1`,
    [feedId],
  );
  return new Map(result.rows.map((row) => [row.guid, row]));
}

const get = (rows: Map<string, ItemRow>, guid: string): ItemRow => {
  const row = rows.get(guid);
  if (row === undefined) throw new Error(`no feed item ${guid}`);
  return row;
};

describe('feed_items.last_seen_at (D-253)', () => {
  it('starts equal to first_seen_at and moves to the fetch time when the item appears again', async () => {
    server.route('/ls/again.rss', () => ({
      status: 200,
      headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
      body: rss(['again-a', 'again-b']),
    }));
    const feedId = await addFeed('/ls/again.rss');
    await fetchFeed(feedId);
    const first = await items(feedId);
    expect(first.size).toBe(2);
    expect(get(first, 'again-a').last.getTime()).toBe(get(first, 'again-a').first.getTime());

    await pause(40);
    const startedAt = new Date();
    await fetchFeed(feedId);
    const second = await items(feedId);
    for (const guid of ['again-a', 'again-b']) {
      // First sighting is history; the last sighting is this fetch.
      expect(get(second, guid).first.getTime()).toBe(get(first, guid).first.getTime());
      expect(get(second, guid).last.getTime(), guid).toBeGreaterThan(
        get(first, guid).last.getTime(),
      );
      expect(get(second, guid).last.getTime(), guid).toBeGreaterThanOrEqual(
        startedAt.getTime() - 1000,
      );
    }
  });

  it('leaves an item that dropped out of the feed untouched while the others move on', async () => {
    let guids = ['drop-a', 'drop-b'];
    server.route('/ls/drop.rss', () => ({
      status: 200,
      headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
      body: rss(guids),
    }));
    const feedId = await addFeed('/ls/drop.rss');
    await fetchFeed(feedId);
    const first = await items(feedId);
    guids = ['drop-a'];
    await pause(40);
    await fetchFeed(feedId);
    const second = await items(feedId);
    expect(get(second, 'drop-a').last.getTime()).toBeGreaterThan(
      get(first, 'drop-a').last.getTime(),
    );
    expect(get(second, 'drop-b').last.getTime()).toBe(get(first, 'drop-b').last.getTime());
  });

  it('after a 304 treats the items of the last successful fetch as still present, and only those', async () => {
    let guids = ['nm-a', 'nm-b'];
    let etag = '"nm-v1"';
    server.route('/ls/notmodified.rss', (request) =>
      request.headers['if-none-match'] === etag
        ? { status: 304, headers: { etag } }
        : {
            status: 200,
            headers: { 'content-type': 'application/rss+xml; charset=utf-8', etag },
            body: rss(guids),
          },
    );
    const feedId = await addFeed('/ls/notmodified.rss');
    await fetchFeed(feedId);
    // The feed changes: nm-b leaves it, the validator moves on.
    guids = ['nm-a'];
    etag = '"nm-v2"';
    await pause(40);
    await fetchFeed(feedId);
    const afterChange = await items(feedId);
    await pause(40);
    // Same validator now: the origin answers 304.
    await fetchFeed(feedId);
    const feed = await owner.query<{ last_error_code: string | null; total_fetches: number }>(
      'SELECT last_error_code, total_fetches FROM feeds WHERE id = $1',
      [feedId],
    );
    expect(feed.rows[0]).toMatchObject({ total_fetches: 3 });
    const afterNotModified = await items(feedId);
    expect(get(afterNotModified, 'nm-a').last.getTime()).toBeGreaterThan(
      get(afterChange, 'nm-a').last.getTime(),
    );
    expect(get(afterNotModified, 'nm-b').last.getTime()).toBe(
      get(afterChange, 'nm-b').last.getTime(),
    );
  });
});
