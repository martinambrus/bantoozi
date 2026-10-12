import {
  MIGRATIONS_FOLDER,
  PG_BOSS_VERSION,
  claimOutboxIntents,
  completeOutboxIntent,
  createDatabase,
  failOutboxIntent,
  runMigrations,
  type Database,
} from '@bantoozi/db';
import { createMemoryOriginLimiter } from '@bantoozi/feeds';
import { parseJobPayload, type QueueName } from '@bantoozi/shared';
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createWorkerDeps } from '../src/handlers/deps.js';
import { createHandlers, dispatch, type HandlerMap } from '../src/handlers/index.js';

/**
 * Launch checklist item 15 (spec 11 §7 "do not create remote src/CSS URLs"): feed fetch, article
 * extraction and bookmark capture fetch the feed, robots.txt and the article page only. The page,
 * the feed item and the channel reference images (`<img src>`, `srcset`, `<picture>`, an inline CSS
 * `url()`, a stylesheet, a feed icon, a media thumbnail and an image enclosure) on the same
 * recording server; none of those paths may ever be requested.
 */

const MEDIA_PATHS = [
  '/media/hero.jpg',
  '/media/small.jpg',
  '/media/large.jpg',
  '/media/picture.webp',
  '/media/inline-bg.png',
  '/media/site.css',
  '/media/css-bg.png',
  '/media/icon.png',
  '/media/thumb.jpg',
  '/media/enclosure.jpg',
  '/media/body-in-feed.jpg',
  '/favicon.ico',
];

let testDb: TestDatabase;
let owner: pg.Pool;
let appPool: pg.Pool;
let workerPool: pg.Pool;
let lockPool: pg.Pool;
let db: Database;
let server: FixtureServer;
let handlers: HandlerMap;

const QUIET = { info: () => {}, warn: () => {}, error: () => {} };

async function drain(queues: readonly QueueName[]): Promise<string[]> {
  const ran: string[] = [];
  for (;;) {
    const claimed = await claimOutboxIntents(db, { limit: 100, leaseSeconds: 120 });
    if (claimed.length === 0) return ran;
    let progressed = false;
    for (const intent of claimed) {
      if (!(queues as readonly string[]).includes(intent.queue)) {
        await failOutboxIntent(db, intent, { error: 'kept', retryInSeconds: 86_400 });
        continue;
      }
      const queue = intent.queue as QueueName;
      await dispatch(handlers, queue, parseJobPayload(queue, intent.payload), {
        queue,
        jobId: intent.id,
      });
      await completeOutboxIntent(db, intent);
      ran.push(queue);
      progressed = true;
    }
    if (!progressed) return ran;
  }
}

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
  appPool = new pg.Pool({ connectionString: testDb.urls.app, max: 2 });
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
      logger: QUIET,
    }),
  );
}, 120_000);

afterAll(async () => {
  await server?.close();
  await Promise.all([owner?.end(), appPool?.end(), workerPool?.end(), lockPool?.end()]);
  await dropCreatedTestDatabases();
});

describe('capture issues no media requests (spec 11 §9 item 15)', () => {
  it('fetches only the feed, robots.txt and the article page', async () => {
    const m = (p: string) => server.url(p);
    const paragraphs = Array.from(
      { length: 4 },
      (_, i) =>
        `<p>Paragraph ${i + 1}: the council approved the new tram line after a long debate, and the ` +
        'first vehicles will run on the Petržalka route from next month, the city said on Monday, adding ' +
        'that tickets stay at their current price for the whole first year of operation.</p>',
    ).join('\n');
    server.route('/pages/media.html', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>The tram line opens</title>
<link rel="stylesheet" href="${m('/media/site.css')}">
<link rel="icon" href="${m('/favicon.ico')}">
<meta property="og:image" content="${m('/media/hero.jpg')}">
<style>.hero { background-image: url(${m('/media/css-bg.png')}); }</style></head>
<body><main><article><h1>The tram line opens</h1>
<img src="${m('/media/hero.jpg')}" alt="hero"
     srcset="${m('/media/small.jpg')} 480w, ${m('/media/large.jpg')} 1200w" sizes="100vw">
<picture><source srcset="${m('/media/picture.webp')}" type="image/webp">
<img src="${m('/media/picture.webp')}" alt="picture"></picture>
<div style="background: url('${m('/media/inline-bg.png')}')">styled</div>
${paragraphs}
</article></main></body></html>`,
    });
    server.route('/feeds/media.rss', {
      headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
      body: `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel><title>Media Feed</title><link>${m('/')}</link><description>Media</description>
<language>en</language>
<image><url>${m('/media/icon.png')}</url><title>Media Feed</title><link>${m('/')}</link></image>
<item><title>The tram line opens</title><link>${m('/pages/media.html')}</link><guid>media-1</guid>
<pubDate>${new Date(Date.now() - 3_600_000).toUTCString()}</pubDate>
<description>The tram line opens next month.</description>
<content:encoded><![CDATA[<p>The tram line opens.</p><img src="${m('/media/body-in-feed.jpg')}">]]></content:encoded>
<media:thumbnail url="${m('/media/thumb.jpg')}"/>
<media:content url="${m('/media/hero.jpg')}" medium="image"/>
<enclosure url="${m('/media/enclosure.jpg')}" type="image/jpeg" length="1234"/>
</item></channel></rss>`,
    });
    const feedId = (
      await owner.query<{ id: string }>(
        'INSERT INTO feeds (url, fetch_url) VALUES ($1, $1) RETURNING id::text AS id',
        [m('/feeds/media.rss')],
      )
    ).rows[0]!.id;
    const user = await createUser(owner);
    await createSubscription(owner, { userId: user.id, feedId, mode: 'off' });
    await owner.query('SELECT refresh_feed_subscribers($1::bigint[], $2::jsonb)', [
      [feedId],
      JSON.stringify({ beta: 900, admin: 300 }),
    ]);

    await dispatch(
      handlers,
      'feed.fetch',
      { feedId, force: true },
      { queue: 'feed.fetch', jobId: 'm' },
    );
    const ran = await drain(['article.extract', 'article.capture-bookmark']);
    expect(ran).toContain('article.extract');
    const article = await owner.query<{ id: string; pipeline_state: string }>(
      'SELECT id::text AS id, pipeline_state FROM articles WHERE url = $1',
      [m('/pages/media.html')],
    );
    expect(article.rows[0]?.pipeline_state).toBe('extracted');
    const body = await owner.query<{ body_html: string | null; status: string }>(
      'SELECT body_html, status FROM article_bodies WHERE article_id = $1',
      [article.rows[0]!.id],
    );
    expect(body.rows[0]?.status).toBe('ok');

    // A bookmark through the real API function, then its capture.
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.user_id', $1, true)", [user.id]);
      await client.query('SELECT * FROM capture_bookmark_snapshot($1, NULL)', [
        article.rows[0]!.id,
      ]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    await drain(['article.extract', 'article.capture-bookmark']);
    const saved = await owner.query<{ status: string | null }>(
      'SELECT bookmark_capture_status AS status FROM user_article WHERE user_id = $1',
      [user.id],
    );
    expect(['saved', 'partial']).toContain(saved.rows[0]?.status);

    // Only the feed, robots.txt and the page itself were requested; no media path ever was.
    const paths = server.requests.map((request) => request.path.split('?')[0]);
    expect(paths).toContain('/feeds/media.rss');
    expect(paths).toContain('/pages/media.html');
    expect(new Set(paths)).toEqual(
      new Set(['/feeds/media.rss', '/pages/media.html', '/robots.txt']),
    );
    for (const media of MEDIA_PATHS) expect(paths).not.toContain(media);
  });
});
