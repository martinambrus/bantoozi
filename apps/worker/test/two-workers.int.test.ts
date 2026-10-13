import {
  MIGRATIONS_FOLDER,
  PG_BOSS_VERSION,
  assertQuotaRoom,
  createDatabase,
  createPgEngineStore,
  createPgOriginLimiter,
  insertSubscription,
  readOwnUser,
  runMigrations,
  withTenant,
  workerOutbox,
  type Database,
  type PgEngineStore,
} from '@bantoozi/db';
import { QuotaExceededError, enqueueFetch, type InferenceAuthorization } from '@bantoozi/shared';
import {
  createArticle,
  createFeed,
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
import type PgBoss from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createBoss, pgBossBroker, registerHandlers } from '../src/boss.js';
import { createWorkerDeps } from '../src/handlers/deps.js';
import { createHandlers, type HandlerMap } from '../src/handlers/index.js';
import { startOutboxRelay, type RelayLoop } from '../src/outbox-relay.js';

/**
 * M8-F12 (launch item 10): two complete worker instances on one database. Each instance is what
 * `main.ts` assembles: its own query and lock pools, its own pg-boss client with the real queue
 * consumers, its own outbox relay and its own PostgreSQL origin limiter. They process concurrent
 * ingestion of overlapping feeds, an article merge racing the extraction of its survivor, a revision
 * change, quota-limited subscribes, budget reservations and an origin-throttled fetch, and the test
 * asserts the invariants that only hold when the database, not a process, is the arbiter: no
 * duplicate articles, consistent merges, a budget that is never exceeded and an origin that is
 * never hit faster than its spacing.
 */

type Label = 'A' | 'B';

const SPACING_MS = 150;
const WAIT_MS = 90_000;

let testDb: TestDatabase;
let owner: pg.Pool;
let server: FixtureServer;

interface Instance {
  label: Label;
  db: Database;
  appDb: Database;
  engine: PgEngineStore;
  boss: PgBoss;
  handlers: HandlerMap;
  relay: RelayLoop;
  pools: pg.Pool[];
  handled: { 'feed.fetch': number; 'article.extract': number };
}

const instances: Partial<Record<Label, Instance>> = {};
const inFlight: Record<Label, number> = { A: 0, B: 0 };
const extracting: Record<Label, number> = { A: 0, B: 0 };
/** Holds instance B's extractions at their start until the test opens the gate. */
const gate: { wait: Promise<void> | undefined; open: () => void } = {
  wait: undefined,
  open: () => {},
};
const overlap = { seen: false };

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until<T>(
  what: string,
  probe: () => Promise<T | undefined | false>,
  timeoutMs = WAIT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}: ${await diagnose()}`);
    }
    await sleep(100);
  }
}

/** What the queues and the outbox hold, for a timeout message. */
async function diagnose(): Promise<string> {
  const jobs = await owner.query(
    `SELECT name, state, count(*)::int AS n FROM pgboss.job GROUP BY 1, 2 ORDER BY 1, 2`,
  );
  const outbox = await owner.query(
    `SELECT queue, coalesce(last_error, '-') AS error, count(*)::int AS n FROM job_outbox
      WHERE delivered_at IS NULL GROUP BY 1, 2 ORDER BY 1, 2`,
  );
  const arts = await owner.query(
    `SELECT id::text, url_key, pipeline_state FROM articles WHERE url_key NOT LIKE '%shared-%' AND url_key NOT LIKE '%own-%'`,
  );
  const aliases = await owner.query(
    `SELECT article_id::text, url_key, source FROM article_aliases`,
  );
  return JSON.stringify({
    arts: arts.rows,
    aliases: aliases.rows,
    jobs: jobs.rows,
    outbox: outbox.rows,
    handled: { A: instances.A?.handled, B: instances.B?.handled },
    inFlight,
    extracting,
    overlap,
  });
}

function instance(label: Label): Instance {
  const found = instances[label];
  if (found === undefined) throw new Error(`instance ${label} is not running`);
  return found;
}

/**
 * While no two instances have processed a feed at the same moment, a feed fetch waits for the other
 * instance to start one (up to eight seconds), so the test proves true overlap instead of hoping
 * for it. Everything else runs the real handler untouched.
 */
function observed(label: Label, base: HandlerMap, handled: Instance['handled']): HandlerMap {
  const other: Label = label === 'A' ? 'B' : 'A';
  const fetchEntry = base['feed.fetch'];
  const extractEntry = base['article.extract'];
  if (fetchEntry.status !== 'implemented' || extractEntry.status !== 'implemented') {
    throw new Error('the ingestion handlers are not implemented');
  }
  return {
    ...base,
    'feed.fetch': {
      status: 'implemented',
      handle: async (payload, context) => {
        handled['feed.fetch'] += 1;
        inFlight[label] += 1;
        try {
          if (inFlight[other] > 0) overlap.seen = true;
          const deadline = Date.now() + 8_000;
          while (!overlap.seen && Date.now() < deadline) {
            await sleep(25);
            if (inFlight[other] > 0) overlap.seen = true;
          }
          await fetchEntry.handle(payload, context);
        } finally {
          inFlight[label] -= 1;
        }
      },
    },
    'article.extract': {
      status: 'implemented',
      handle: async (payload, context) => {
        handled['article.extract'] += 1;
        extracting[label] += 1;
        try {
          if (label === 'B') await gate.wait;
          await extractEntry.handle(payload, context);
        } finally {
          extracting[label] -= 1;
        }
      },
    },
  } as HandlerMap;
}

/** Stops one instance from taking new jobs of a queue; jobs in flight run to the end. */
async function pause(
  label: Label,
  queue: 'feed.fetch' | 'article.extract',
  settleMs = 0,
): Promise<void> {
  await instance(label).boss.offWork(queue);
  // A consumer in the middle of its poll may still take one job: let those polls pass.
  await sleep(settleMs);
}

async function resume(label: Label, queue: 'feed.fetch' | 'article.extract'): Promise<void> {
  const { boss, handlers } = instance(label);
  await registerHandlers(boss, handlers, [queue], silent);
}

async function startInstance(label: Label): Promise<Instance> {
  const query = new pg.Pool({ connectionString: testDb.urls.worker, max: 8 });
  const locks = new pg.Pool({ connectionString: testDb.urls.worker, max: 20 });
  const app = new pg.Pool({ connectionString: testDb.urls.app, max: 6 });
  const db = createDatabase(query);
  const handled: Instance['handled'] = { 'feed.fetch': 0, 'article.extract': 0 };
  const base = createHandlers(
    createWorkerDeps({
      db,
      lockPool: locks,
      fetch: {
        userAgent: 'BantooziBot/1.0 (+https://bantoozi.test/bot)',
        timeoutMs: 30_000,
        maxBytes: 5 * 1024 * 1024,
        allowPrivate: true,
      },
      ingestMaxAgeDays: 14,
      settingsEnv: {
        dailyBudgetUsd: 2,
        languageModes: { en: 'native', sk: 'native', cs: 'native' },
        signupMode: 'invite',
      },
      // The production limiter: one row per origin in the database, shared by both instances.
      limiter: createPgOriginLimiter(db, { spacingMs: SPACING_MS }),
      logger: silent,
    }),
  );
  const handlers = observed(label, base, handled);
  const boss = createBoss(testDb.urls.worker);
  boss.on('error', () => {});
  await boss.start();
  await registerHandlers(boss, handlers, ['feed.fetch', 'article.extract'], silent);
  const relay = startOutboxRelay(db, pgBossBroker(boss), {
    handlers,
    logger: silent,
    intervalMs: 100,
  });
  const started: Instance = {
    label,
    db,
    appDb: createDatabase(app),
    engine: createPgEngineStore(db, { dailyBudgetUsd: 1 }),
    boss,
    handlers,
    relay,
    pools: [query, locks, app],
    handled,
  };
  instances[label] = started;
  return started;
}

async function stopInstance(started: Instance | undefined): Promise<void> {
  if (started === undefined) return;
  await started.relay.stop();
  await started.boss.stop({ graceful: true, timeout: 10_000, wait: true });
  await Promise.all(started.pools.map((pool) => pool.end()));
}

// ---------------------------------------------------------------------------------------------
// The fixture publisher
// ---------------------------------------------------------------------------------------------

interface Item {
  title: string;
  slug: string;
  /** The link in the feed when it is not the page itself (a wrapper that redirects). */
  link?: string;
}

const SENTENCES = [
  'The regional council published the results of its survey after several months of fieldwork.',
  'Residents described how the new schedule changed their daily routines in small but lasting ways.',
  'Engineers explained that the project depended on three separate suppliers delivering on time.',
  'A spokesperson said the next stage would begin once the independent review had been completed.',
  'Local businesses reported steady demand through the autumn and expect the trend to continue.',
  'Researchers compared the figures with those of the previous decade and found a clear pattern.',
];

function pageHtml(item: Item): string {
  const paragraph = (n: number) =>
    SENTENCES.map((sentence, i) => SENTENCES[(i + n) % SENTENCES.length]).join(' ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${item.title}</title></head>
<body><article><h1>${item.title}</h1>
<p>${item.title}: ${paragraph(0)}</p><p>${paragraph(2)}</p><p>${paragraph(4)}</p>
<p>${paragraph(1)}</p></article></body></html>`;
}

const pageUrl = (slug: string) => server.url(`/pages/${slug}.html`);
const rfc822 = () => new Date(Date.now() - 3_600_000).toUTCString();

function rss(title: string, items: readonly Item[]): string {
  const entries = items
    .map(
      (item) => `<item><title>${item.title}</title><link>${item.link ?? pageUrl(item.slug)}</link>
<guid>${item.slug}</guid><pubDate>${rfc822()}</pubDate>
<description>${item.title} in short.</description></item>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>${title}</title><link>${server.url('/')}</link>
<description>${title}</description><language>en</language>${entries}</channel></rss>`;
}

/** More feeds than one instance has consumers (16), so both instances must take part. */
const FEEDS = 20;
const SHARED = 6;
const UNIQUE = 2;
const MERGES = 3;

/** Feeds f0…f7: every feed carries the shared articles; the first feed introduces them. */
const sharedItems = (feed: number): Item[] =>
  Array.from({ length: SHARED }, (_, i) => ({
    title: i === 0 && feed === script.retitledFeed ? script.retitled : sharedTitle(i),
    slug: `shared-${i}`,
  }));
/** The one feed (by index) that publishes a corrected title of the first shared story. */
const script = { retitled: '', retitledFeed: -1 };
const sharedTitle = (i: number) => `Shared story number ${i} of the week`;
const uniqueItems = (feed: number): Item[] =>
  Array.from({ length: UNIQUE }, (_, i) => ({
    title: `Feed ${feed} exclusive story ${i}`,
    slug: `f${feed}-own-${i}`,
  }));
const targetItems = (): Item[] =>
  Array.from({ length: MERGES }, (_, i) => ({
    title: `Harbour report ${i} reaches the council`,
    slug: `merge-${i}`,
  }));
const wrapperPath = (i: number) => `/rss/articles/Wrap${i}`;
const wrapperUrl = (i: number) => `${server.url(wrapperPath(i))}?oc=5`;
const wrapperItems = (): Item[] =>
  targetItems().map((item, i) => ({ ...item, slug: `wrap-${i}`, link: wrapperUrl(i) }));

const feedIds: Record<string, string> = {};
const feedPath = (name: string) => `/feeds/${name}.rss`;

async function addFeed(name: string): Promise<string> {
  const url = server.url(feedPath(name));
  const result = await owner.query<{ id: string }>(
    'INSERT INTO feeds (url, fetch_url) VALUES ($1, $1) RETURNING id::text AS id',
    [url],
  );
  feedIds[name] = result.rows[0]!.id;
  return feedIds[name]!;
}

async function queueFetches(names: readonly string[], via: Label = 'A'): Promise<void> {
  await instance(via).db.transaction(async (tx) => {
    for (const name of names)
      await enqueueFetch(workerOutbox(tx), { feedId: feedIds[name]!, force: true });
  });
}

interface ArticleRow {
  id: string;
  url_key: string;
  pipeline_state: string;
  content_revision: string;
  title: string;
}

async function articles(): Promise<ArticleRow[]> {
  const result = await owner.query<ArticleRow>(
    `SELECT id::text AS id, url_key, pipeline_state, content_revision::text AS content_revision, title
       FROM articles ORDER BY id`,
  );
  return result.rows;
}

async function byKey(url: string): Promise<ArticleRow | undefined> {
  return (await articles()).find((row) => row.url_key === url);
}

async function carriers(articleId: string): Promise<string[]> {
  const result = await owner.query<{ feed_id: string }>(
    'SELECT feed_id::text AS feed_id FROM feed_items WHERE article_id = $1',
    [articleId],
  );
  return result.rows.map((row) => row.feed_id).sort((a, b) => Number(a) - Number(b));
}

let users: UserFixture[] = [];

/** A page of the overlapping feeds (not a merge pair, not a fixture row of another scenario). */
const isOverlapPage = (urlKey: string) =>
  urlKey.startsWith(server.url('/pages/')) &&
  !urlKey.includes('merge-') &&
  !urlKey.includes('wrap-');

beforeAll(async () => {
  testDb = await setupTestDatabase({
    pkg: 'worker',
    migrationsDir: MIGRATIONS_FOLDER,
    pgBossVersion: PG_BOSS_VERSION,
    migrate: async (url) => {
      await runMigrations({ databaseUrl: url });
    },
  });
  owner = new pg.Pool({ connectionString: testDb.urls.owner, max: 4 });
  server = await startFixtureServer();
  const xml = (body: () => string) => () => ({
    status: 200,
    headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
    body: body(),
  });
  for (let f = 0; f < FEEDS; f += 1) {
    server.route(
      feedPath(`f${f}`),
      xml(() => rss(`Feed ${f}`, [...sharedItems(f), ...uniqueItems(f)])),
    );
    await addFeed(`f${f}`);
  }
  for (const item of [
    ...sharedItems(-1),
    ...Array.from({ length: FEEDS }, (_, f) => uniqueItems(f)).flat(),
    ...targetItems(),
  ]) {
    server.route(`/pages/${item.slug}.html`, () => ({
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: pageHtml({
        ...item,
        title: item.slug === 'shared-0' && script.retitled !== '' ? script.retitled : item.title,
      }),
    }));
  }
  server.route(
    feedPath('wrap'),
    xml(() => rss('Wrappers', wrapperItems())),
  );
  server.route(
    feedPath('direct'),
    xml(() => rss('Direct', targetItems())),
  );
  // The wrapper's redirect answers slowly, so its extraction is in flight while the direct feed is
  // fetched and its target extracted by the other instance.
  for (let i = 0; i < MERGES; i += 1) {
    server.route(wrapperPath(i), {
      status: 301,
      headers: { location: pageUrl(`merge-${i}`) },
      delayMs: 500,
    });
  }
  await addFeed('wrap');
  await addFeed('direct');

  users = [await createUser(owner), await createUser(owner), await createUser(owner)];
  for (const [n, user] of users.entries()) {
    for (let f = n; f < FEEDS; f += 3) {
      await createSubscription(owner, { userId: user.id, feedId: feedIds[`f${f}`]!, mode: 'off' });
    }
    for (const name of ['wrap', 'direct']) {
      await createSubscription(owner, { userId: user.id, feedId: feedIds[name]!, mode: 'off' });
    }
  }
  const all = Object.values(feedIds);
  await owner.query('SELECT refresh_feed_subscribers($1::bigint[], $2::jsonb)', [
    all,
    JSON.stringify({ beta: 900, admin: 300 }),
  ]);
  await owner.query('SELECT refresh_feed_cards($1::bigint[])', [all]);

  await startInstance('A');
  await startInstance('B');
});

afterAll(async () => {
  await stopInstance(instances.A);
  await stopInstance(instances.B);
  await server?.close();
  await owner?.end();
  await dropCreatedTestDatabases();
});

// ---------------------------------------------------------------------------------------------
// Scenarios, in order: each builds on the database state of the previous one.
// ---------------------------------------------------------------------------------------------

describe('two worker instances on one database (M8-F12)', () => {
  let phaseOneStart = 0;
  let phaseOneEnd = 0;

  it(
    'ingests overlapping feeds once, with quota-limited subscribes and budget reservations racing',
    { timeout: 150_000 },
    async () => {
      // Quota: one reader tries to subscribe to eight feeds at once through both instances' API-side
      // pools; the quota is three. Budget: forty reservations of 0.1 against a 1.0 day.
      const quotaUser = await createUser(owner);
      const quotaFeeds: string[] = [];
      for (let q = 0; q < 8; q += 1) {
        const feed = await createFeed(owner);
        quotaFeeds.push(feed.id);
      }
      const feed = await createFeed(owner);
      const reader = await createUser(owner);
      await createSubscription(owner, {
        userId: reader.id,
        feedId: feed.id,
        mode: 'active',
        activatedAt: new Date(Date.now() - 2 * 3_600_000),
      });
      const article = await createArticle(owner, { feedIds: [feed.id] });
      const authorization: InferenceAuthorization = {
        type: 'article',
        articleId: article.id,
        articleRevision: article.contentRevision,
        witnesses: [
          { kind: 'automatic', userId: reader.id, feedId: feed.id, inferenceVersion: '1' },
        ],
      };
      const day = '2031-03-05';

      phaseOneStart = Date.now();
      await queueFetches(
        Array.from({ length: FEEDS }, (_, f) => `f${f}`),
        'A',
      );

      const subscribe = (via: Label, feedId: string) =>
        withTenant(instance(via).appDb, quotaUser.id, async (tx) => {
          await readOwnUser(tx, { lock: true });
          await assertQuotaRoom(tx, 'maxFeeds', 3);
          return insertSubscription(tx, { feedId, folder: null });
        });
      const reserve = (via: Label) =>
        instance(via).engine.reserveSpend({
          day,
          engine: 'typesafe',
          kind: 'enrich',
          estimateUsd: 0.1,
          priority: 'bulk',
          authorization,
        });

      const [subscribes, reservations] = await Promise.all([
        Promise.allSettled(
          quotaFeeds.map((feedId, i) => subscribe(i % 2 === 0 ? 'A' : 'B', feedId)),
        ),
        Promise.all(Array.from({ length: 40 }, (_, i) => reserve(i % 2 === 0 ? 'A' : 'B'))),
      ]);

      // Subscribes: exactly the quota fits, the rest are refused with QUOTA_EXCEEDED.
      expect(subscribes.filter((s) => s.status === 'fulfilled')).toHaveLength(3);
      const refused = subscribes.filter((s) => s.status === 'rejected');
      expect(refused).toHaveLength(5);
      for (const r of refused)
        expect((r as PromiseRejectedResult).reason).toBeInstanceOf(QuotaExceededError);
      const held = await owner.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM subscriptions WHERE user_id = $1',
        [quotaUser.id],
      );
      expect(held.rows[0]!.n).toBe(3);

      // Budget: exactly ten reservations fit; the committed total never passes the day's budget.
      expect(reservations.filter((id) => id !== null)).toHaveLength(10);
      const committed = await owner.query<{ usd: string; n: number }>(
        `SELECT coalesce(sum(reserved_usd), 0)::text AS usd, count(*)::int AS n
         FROM engine_reservations WHERE day = $1::date`,
        [day],
      );
      expect(Number(committed.rows[0]!.usd)).toBeLessThanOrEqual(1 + 1e-9);
      expect(committed.rows[0]!.n).toBe(10);

      // Ingestion: wait until every article of the eight overlapping feeds is extracted.
      const expected = SHARED + FEEDS * UNIQUE;
      await until('all overlapping articles extracted', async () => {
        const rows = (await articles()).filter((r) => isOverlapPage(r.url_key));
        return (
          rows.length >= expected && rows.every((r) => r.pipeline_state === 'extracted') && rows
        );
      });
      phaseOneEnd = Date.now();

      const rows = (await articles()).filter((r) => isOverlapPage(r.url_key));
      // No duplicates: one row per page, however many feeds and instances carried it.
      expect(rows).toHaveLength(expected);
      expect(new Set(rows.map((r) => r.url_key)).size).toBe(expected);
      const duplicateKeys = await owner.query(
        `SELECT url_key FROM (
         SELECT url_key FROM articles
         UNION ALL SELECT url_key FROM article_aliases) k GROUP BY url_key HAVING count(*) > 1`,
      );
      expect(duplicateKeys.rowCount).toBe(0);
      for (let i = 0; i < SHARED; i += 1) {
        const shared = rows.find((r) => r.url_key === pageUrl(`shared-${i}`))!;
        expect(await carriers(shared.id)).toEqual(
          Array.from({ length: FEEDS }, (_, f) => feedIds[`f${f}`]!).sort(
            (a, b) => Number(a) - Number(b),
          ),
        );
        const bodies = await owner.query('SELECT 1 FROM article_bodies WHERE article_id = $1', [
          shared.id,
        ]);
        expect(bodies.rowCount).toBe(1);
      }

      // Each feed was fetched exactly once (its singleton key and lock), by whichever instance won,
      // and both instances took part, at the same time.
      const fetches = instance('A').handled['feed.fetch'] + instance('B').handled['feed.fetch'];
      expect(fetches).toBe(FEEDS);
      expect(instance('A').handled['feed.fetch']).toBeGreaterThan(0);
      expect(instance('B').handled['feed.fetch']).toBeGreaterThan(0);
      expect(overlap.seen).toBe(true);
      const totals = await owner.query<{ id: string; total_fetches: number }>(
        'SELECT id::text AS id, total_fetches FROM feeds WHERE id = ANY($1::bigint[])',
        [Array.from({ length: FEEDS }, (_, f) => feedIds[`f${f}`])],
      );
      for (const row of totals.rows) expect(row.total_fetches).toBe(1);
      // Every article was extracted by someone, and by both instances between them.
      const extracts =
        instance('A').handled['article.extract'] + instance('B').handled['article.extract'];
      expect(extracts).toBeGreaterThanOrEqual(expected);
    },
  );

  it('never reaches the origin faster than its spacing, from either instance', () => {
    const arrivals = server.requests
      .filter((r) => r.at.getTime() >= phaseOneStart && r.at.getTime() <= phaseOneEnd + 1_000)
      .map((r) => r.at.getTime())
      .sort((a, b) => a - b);
    expect(arrivals.length).toBeGreaterThanOrEqual(FEEDS + SHARED + FEEDS * UNIQUE);
    // A start slot is granted every SPACING_MS; arrival jitter blurs single gaps but not a window.
    const window = 6;
    for (let i = 0; i + window < arrivals.length; i += 1) {
      const span = arrivals[i + window]! - arrivals[i]!;
      expect(span).toBeGreaterThanOrEqual(window * SPACING_MS - 200);
    }
    const elapsed = arrivals.at(-1)! - arrivals[0]!;
    expect(elapsed).toBeGreaterThanOrEqual((arrivals.length - 1) * SPACING_MS * 0.8);
  });

  it(
    'merges a wrapper into its target while the other instance extracts the target, keeping reader state',
    { timeout: 150_000 },
    async () => {
      const [u1, u2] = users as [UserFixture, UserFixture];
      // Instance A takes no extraction for now: the wrappers' extraction is B's, and B holds it
      // at its start until the targets exist.
      gate.wait = new Promise<void>((resolve) => {
        gate.open = resolve;
      });
      await pause('A', 'article.extract', 2_500);
      await queueFetches(['wrap'], 'A');
      const wrappers = await until('the wrapper articles', async () => {
        const found = await Promise.all(
          Array.from({ length: MERGES }, (_, i) => byKey(wrapperUrl(i))),
        );
        return found.every((row) => row !== undefined) && (found as ArticleRow[]);
      });
      // u1 rates every wrapper while its (slow) extraction is still in flight.
      for (const wrapper of wrappers) {
        await owner.query(
          `INSERT INTO user_article (user_id, article_id, rating, rated_at, read_at, state_version)
         VALUES ($1, $2, 1, now(), now(), 4)`,
          [u1.id, wrapper.id],
        );
      }
      await until('B extracting every wrapper', async () => extracting.B === MERGES);
      // B keeps its three wrappers in flight and takes no more; A takes the targets' extraction.
      await pause('B', 'article.extract');
      await resume('A', 'article.extract');
      const extractedByA = instance('A').handled['article.extract'];
      await queueFetches(['direct'], 'B');
      const targets = await until('the target articles', async () => {
        const found = await Promise.all(
          Array.from({ length: MERGES }, (_, i) => byKey(pageUrl(`merge-${i}`))),
        );
        return found.every((row) => row !== undefined) && (found as ArticleRow[]);
      });
      for (const target of targets) {
        await owner.query(
          `INSERT INTO user_article (user_id, article_id, rating, reason, rated_at, state_version)
         VALUES ($1, $2, -1, 'seen', now(), 7)`,
          [u2.id, target.id],
        );
      }
      // The wrappers' extraction starts now, while A still has the targets' extraction to do.
      gate.open();
      gate.wait = undefined;

      await until('the wrappers merged away', async () => {
        const gone = await Promise.all(
          wrappers.map((w) => owner.query('SELECT 1 FROM articles WHERE id = $1', [w.id])),
        );
        return gone.every((r) => r.rowCount === 0) && true;
      });
      await until('the targets extracted', async () => {
        const rows = await Promise.all(
          Array.from({ length: MERGES }, (_, i) => byKey(pageUrl(`merge-${i}`))),
        );
        return rows.every((r) => r?.pipeline_state === 'extracted') && true;
      });

      for (let i = 0; i < MERGES; i += 1) {
        const survivor = (await byKey(pageUrl(`merge-${i}`)))!;
        // One article per page, the wrapper's identity now an alias of it.
        expect((await articles()).filter((r) => r.url_key === pageUrl(`merge-${i}`))).toHaveLength(
          1,
        );
        expect(await byKey(wrapperUrl(i))).toBeUndefined();
        const alias = await owner.query<{ article_id: string; source: string }>(
          'SELECT article_id::text AS article_id, source FROM article_aliases WHERE url_key = $1',
          [wrapperUrl(i)],
        );
        expect(alias.rows).toEqual([{ article_id: survivor.id, source: 'redirect' }]);
        expect(await carriers(survivor.id)).toEqual(
          [feedIds['wrap']!, feedIds['direct']!].sort((a, b) => Number(a) - Number(b)),
        );
        const states = await owner.query<{ user_id: string; rating: number; version: string }>(
          `SELECT user_id::text AS user_id, rating, state_version::text AS version
           FROM user_article WHERE article_id = $1 ORDER BY user_id`,
          [survivor.id],
        );
        const byUser = new Map(states.rows.map((r) => [r.user_id, r]));
        // u1's rating followed the wrapper to the survivor; u2's own row is untouched.
        expect(byUser.get(u1.id)).toMatchObject({ rating: 1 });
        expect(byUser.get(u2.id)).toMatchObject({ rating: -1, version: '7' });
        expect(states.rows).toHaveLength(2);
      }
      // No row anywhere still points at a merged-away article.
      const orphans = await owner.query(
        `SELECT 1 FROM user_article ua LEFT JOIN articles a ON a.id = ua.article_id WHERE a.id IS NULL
       UNION ALL SELECT 1 FROM feed_items fi LEFT JOIN articles a ON a.id = fi.article_id WHERE a.id IS NULL`,
      );
      expect(orphans.rowCount).toBe(0);
      // The targets were extracted by A while B held the wrappers: the merge crossed instances.
      expect(instance('A').handled['article.extract'] - extractedByA).toBeGreaterThanOrEqual(
        MERGES,
      );
      await resume('B', 'article.extract');
    },
  );

  it(
    'applies a revision change once while the carriers are fetched on both instances',
    { timeout: 150_000 },
    async () => {
      const before = (await byKey(pageUrl('shared-0')))!;
      expect(before.pipeline_state).toBe('extracted');
      // Only the article's source feed may change its title; the other carriers keep the old one.
      const source = await owner.query<{ feed_id: string }>(
        `SELECT feed_id::text AS feed_id FROM feed_items WHERE article_id = $1
          ORDER BY first_seen_at, feed_id LIMIT 1`,
        [before.id],
      );
      const sourceIndex = Array.from({ length: FEEDS }, (_, f) => f).find(
        (f) => feedIds[`f${f}`] === source.rows[0]!.feed_id,
      )!;
      const others = Array.from({ length: FEEDS }, (_, f) => f).filter((f) => f !== sourceIndex);
      script.retitled = 'Shared story zero was corrected after publication';
      script.retitledFeed = sourceIndex;
      const fetchesBefore = (
        await owner.query<{ n: number }>('SELECT sum(total_fetches)::int AS n FROM feeds')
      ).rows[0]!.n;
      await queueFetches([`f${sourceIndex}`], 'A');
      await queueFetches(
        others.slice(0, 4).map((f) => `f${f}`),
        'B',
      );
      await until('the new revision extracted', async () => {
        const row = await byKey(pageUrl('shared-0'));
        return (
          row?.pipeline_state === 'extracted' &&
          row.content_revision !== before.content_revision &&
          row
        );
      });
      await until('every carrier fetched', async () => {
        const total = (
          await owner.query<{ n: number }>('SELECT sum(total_fetches)::int AS n FROM feeds')
        ).rows[0]!.n;
        return total >= fetchesBefore + 5;
      });
      const after = (await byKey(pageUrl('shared-0')))!;
      expect(BigInt(after.content_revision)).toBe(BigInt(before.content_revision) + 1n);
      expect(after.title).toBe(script.retitled);
      // The stored body belongs to the current revision, never to the superseded one.
      const body = await owner.query<{ article_revision: string; body_text: string }>(
        'SELECT article_revision::text AS article_revision, body_text FROM article_bodies WHERE article_id = $1',
        [after.id],
      );
      expect(body.rows).toHaveLength(1);
      expect(body.rows[0]!.article_revision).toBe(after.content_revision);
      expect(body.rows[0]!.body_text).toContain('corrected after publication');
      // Still one row per page after every race above.
      const keys = (await articles()).map((r) => r.url_key);
      expect(new Set(keys).size).toBe(keys.length);
    },
  );
});
