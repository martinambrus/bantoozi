import {
  MIGRATIONS_FOLDER,
  PG_BOSS_VERSION,
  createDatabase,
  runMigrations,
  subscribeToFeed,
  workerOutbox,
  type Database,
} from '@bantoozi/db';
import {
  canonicalizeUrl,
  createMemoryOriginLimiter,
  decodeBody,
  discoverFeed,
  parseFeed,
  urlKey,
} from '@bantoozi/feeds';
import { parseJobPayload, type OriginLimiter, type QueueName } from '@bantoozi/shared';
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

import { createWorkerDeps, fetchWith, type WorkerDeps } from '../src/handlers/deps.js';
import { createHandlers, dispatch, type HandlerMap } from '../src/handlers/index.js';

/**
 * M1-T7 handler integration (spec 03 §3–§4, §7–§10): the real `feed.schedule`, `feed.fetch`,
 * `article.extract` and `article.capture-bookmark` handlers against a migrated database and the
 * local fixture server. Repository rules (identity, merges, demand, resets) have their own tests in
 * `packages/db`; this file proves the handlers wire them to HTTP, parsing and extraction.
 */

const DAY = 86_400_000;
const rfc822 = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toUTCString();

let testDb: TestDatabase;
let owner: pg.Pool;
let appPool: pg.Pool;
let workerPool: pg.Pool;
let lockPool: pg.Pool;
let db: Database;
let server: FixtureServer;
let deps: WorkerDeps;
let handlers: HandlerMap;
let reader: UserFixture;

const silent = { info: () => {}, warn: () => {}, error: () => {} };

function workerDeps(limiter: OriginLimiter): WorkerDeps {
  return createWorkerDeps({
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
    limiter,
    logger: silent,
  });
}

/** A readable article page (well above Readability's 500-character "complete" threshold). */
function articlePage(title: string, options: { canonical?: string; lang?: string } = {}): string {
  const paragraphs = Array.from(
    { length: 6 },
    (_, i) =>
      `<p>${title}, part ${i + 1}. The city council approved the new tram line after a long public ` +
      'consultation, and construction crews will start work on the northern section next spring. ' +
      'Residents asked for quieter vehicles and more frequent service in the evenings.</p>',
  ).join('\n');
  const canonical =
    options.canonical === undefined ? '' : `<link rel="canonical" href="${options.canonical}">`;
  return `<!doctype html><html lang="${options.lang ?? 'en'}"><head><meta charset="utf-8">
<title>${title}</title>${canonical}</head>
<body><nav><a href="/">Home</a></nav><article><h1>${title}</h1>${paragraphs}</article></body></html>`;
}

function html(body: string) {
  return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body };
}

function rss(title: string, items: string, language?: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>${title}</title><link>${server.url('/')}</link>
<description>${title}</description>${language === undefined ? '' : `<language>${language}</language>`}
${items}
</channel></rss>`;
}

function rssItem(guid: string, title: string, link: string): string {
  return `<item><title>${title}</title><link>${link}</link><guid>${guid}</guid>
<pubDate>${rfc822(1)}</pubDate><description>${title}: the summary from the feed.</description></item>`;
}

function rssRoute(body: () => string, headers: Record<string, string> = {}) {
  return () => ({
    status: 200,
    headers: { 'content-type': 'application/rss+xml; charset=utf-8', ...headers },
    body: body(),
  });
}

async function addFeed(
  path: string,
  subscribers: Array<{ user: UserFixture; mode: 'off' | 'active' }>,
) {
  const url = server.url(path);
  const result = await owner.query<{ id: string }>(
    'INSERT INTO feeds (url, fetch_url) VALUES ($1, $1) RETURNING id::text AS id',
    [url],
  );
  const feedId = result.rows[0]!.id;
  for (const { user, mode } of subscribers) {
    await createSubscription(owner, {
      userId: user.id,
      feedId,
      mode,
      ...(mode === 'active' ? { activatedAt: new Date(Date.now() - 60_000) } : {}),
    });
  }
  await owner.query('SELECT refresh_feed_subscribers($1::bigint[], $2::jsonb)', [
    [feedId],
    JSON.stringify({ beta: 900, admin: 300 }),
  ]);
  await owner.query('SELECT refresh_feed_cards($1::bigint[])', [[feedId]]);
  return feedId;
}

async function fetchFeed(feedId: string, map: HandlerMap = handlers): Promise<void> {
  await dispatch(map, 'feed.fetch', { feedId, force: true }, { queue: 'feed.fetch', jobId: 't7' });
}

/** Deliver the pending intents of one implemented queue through its real handler. */
async function run(queue: QueueName): Promise<number> {
  let ran = 0;
  for (;;) {
    const pending = await owner.query<{ id: string; payload: Record<string, unknown> }>(
      `SELECT id::text AS id, payload FROM job_outbox
        WHERE queue = $1 AND delivered_at IS NULL ORDER BY id`,
      [queue],
    );
    if (pending.rows.length === 0) return ran;
    for (const row of pending.rows) {
      await owner.query('UPDATE job_outbox SET delivered_at = now() WHERE id = $1', [row.id]);
      await dispatch(handlers, queue, parseJobPayload(queue, row.payload), {
        queue,
        jobId: row.id,
      });
      ran += 1;
    }
  }
}

async function intents(queue: string, articleId?: string): Promise<Array<Record<string, unknown>>> {
  const result = await owner.query<{ payload: Record<string, unknown> }>(
    'SELECT payload FROM job_outbox WHERE queue = $1 ORDER BY id',
    [queue],
  );
  return result.rows
    .map((r) => r.payload)
    .filter((p) => articleId === undefined || p['articleId'] === articleId);
}

function keyOf(url: string): string {
  const canonical = canonicalizeUrl(url);
  if (!canonical.ok) throw new Error(`not canonicalizable: ${url}`);
  return urlKey(canonical.url);
}

async function articleIdByUrl(url: string): Promise<string> {
  const result = await owner.query<{ id: string }>(
    'SELECT id::text AS id FROM articles WHERE url_key = $1',
    [keyOf(url)],
  );
  if (result.rows[0] === undefined) throw new Error(`no article for ${url}`);
  return result.rows[0].id;
}

async function feedRow(feedId: string) {
  const result = await owner.query<{
    url: string;
    fetch_url: string;
    total_fetches: number;
    consecutive_errors: number;
    last_error_code: string | null;
    lang_hint: string | null;
    etag: string | null;
    next_fetch_at: Date;
  }>(
    `SELECT url, fetch_url, total_fetches, consecutive_errors, last_error_code, lang_hint, etag,
            next_fetch_at
       FROM feeds WHERE id = $1`,
    [feedId],
  );
  return result.rows[0]!;
}

async function bookmark(user: UserFixture, articleId: string) {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.user_id', $1, true)", [user.id]);
    const result = await client.query<{ capture_status: string }>(
      'SELECT capture_status FROM capture_bookmark_snapshot($1, NULL)',
      [articleId],
    );
    await client.query('COMMIT');
    return result.rows[0]!.capture_status;
  } finally {
    client.release();
  }
}

async function capture(user: UserFixture, articleId: string) {
  const result = await owner.query<{
    status: string;
    error: string | null;
    completeness: string | null;
    reason: string | null;
    source: string | null;
    text: string | null;
  }>(
    `SELECT ua.bookmark_capture_status AS status, ua.bookmark_capture_error_code AS error,
            s.completeness, s.completeness_reason AS reason, s.source, s.body_text AS text
       FROM user_article ua LEFT JOIN article_snapshots s ON s.id = ua.bookmark_snapshot_id
      WHERE ua.user_id = $1 AND ua.article_id = $2`,
    [user.id, articleId],
  );
  return result.rows[0]!;
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
  deps = workerDeps(createMemoryOriginLimiter({ spacingMs: 0 }));
  handlers = createHandlers(deps);
  reader = await createUser(owner);
});

afterAll(async () => {
  await server?.close();
  await Promise.all([owner?.end(), appPool?.end(), workerPool?.end(), lockPool?.end()]);
  await dropCreatedTestDatabases();
});

describe('feed.schedule and feed.fetch (M1-T7)', () => {
  it('fetches a feed subscribed through a signed URL with fetch_url; feeds.url stays canonical', async () => {
    // The publisher signs the whole query, tracking parameter included: dropping utm_source
    // (as canonicalization does) breaks the signature.
    const signed = (path: string) =>
      path.includes('utm_source=partner') && path.includes('sig=s1gn3d');
    server.route('/signed/feed.rss', (request) =>
      signed(request.path)
        ? rssRoute(() =>
            rss('Signed', rssItem('s-1', 'Signed item', server.url('/signed/one.html'))),
          )()
        : { status: 403, body: 'bad signature' },
    );
    const input = server.url('/signed/feed.rss?utm_source=partner&sig=s1gn3d');
    const found = await discoverFeed(input, {
      fetch: (url, options) => fetchWith(deps, url, options),
      parse: parseFeed,
      decode: decodeBody,
      allowPrivate: true,
    });
    if (!found.ok) throw new Error(`discovery failed: ${found.code}`);
    const candidate = found.candidates[0]!;
    expect(candidate.url).toBe(input);
    expect(candidate.canonicalUrl).toBe(server.url('/signed/feed.rss?sig=s1gn3d'));

    const { feedId } = await db.transaction((tx) =>
      subscribeToFeed(tx, workerOutbox(tx), {
        userId: reader.id,
        url: candidate.canonicalUrl,
        fetchUrl: candidate.url,
        title: null,
      }),
    );
    expect(await run('feed.fetch')).toBe(1);

    expect(await feedRow(feedId)).toMatchObject({
      url: server.url('/signed/feed.rss?sig=s1gn3d'),
      fetch_url: input,
      total_fetches: 1,
      consecutive_errors: 0,
    });
    expect(await articleIdByUrl(server.url('/signed/one.html'))).toBeTruthy();
    const feedRequests = server.requests.filter((r) => r.path.startsWith('/signed/feed.rss'));
    expect(feedRequests.length).toBeGreaterThanOrEqual(2); // discovery + fetch
    expect(feedRequests.every((r) => signed(r.path))).toBe(true);
  });

  it('enqueues due subscribed feeds only', async () => {
    const due = await addFeed('/schedule/due.rss', [{ user: reader, mode: 'off' }]);
    const paused = await addFeed('/schedule/paused.rss', [{ user: reader, mode: 'off' }]);
    const unsubscribed = await addFeed('/schedule/none.rss', []);
    const later = await addFeed('/schedule/later.rss', [{ user: reader, mode: 'off' }]);
    await owner.query(
      `UPDATE feeds SET next_fetch_at = now() - interval '1 minute' WHERE id = ANY($1::bigint[])`,
      [[due, paused, unsubscribed]],
    );
    await owner.query(`UPDATE feeds SET next_fetch_at = now() + interval '1 hour' WHERE id = $1`, [
      later,
    ]);
    await owner.query(`UPDATE feeds SET status = 'paused' WHERE id = $1`, [paused]);
    await owner.query(`UPDATE job_outbox SET delivered_at = now() WHERE queue = 'feed.fetch'`);

    await dispatch(handlers, 'feed.schedule', {}, { queue: 'feed.schedule', jobId: 't7' });

    const queued = await owner.query<{ feed_id: string }>(
      `SELECT payload->>'feedId' AS feed_id FROM job_outbox
        WHERE queue = 'feed.fetch' AND delivered_at IS NULL`,
    );
    const ids = queued.rows.map((r) => r.feed_id);
    expect(ids).toContain(due);
    expect(ids).not.toContain(paused);
    expect(ids).not.toContain(unsubscribed);
    expect(ids).not.toContain(later);
    await owner.query(`UPDATE job_outbox SET delivered_at = now() WHERE queue = 'feed.fetch'`);
  });

  it('sends the stored validators and treats a 304 as not modified', async () => {
    let conditional: string | undefined;
    server.route('/conditional/feed.rss', (request) => {
      const tag = request.headers['if-none-match'];
      conditional = typeof tag === 'string' ? tag : undefined;
      return tag === '"v1"'
        ? { status: 304, headers: { etag: '"v1"' } }
        : rssRoute(
            () => rss('Conditional', rssItem('c-1', 'Conditional item', server.url('/c/1.html'))),
            { etag: '"v1"' },
          )();
    });
    const feedId = await addFeed('/conditional/feed.rss', [{ user: reader, mode: 'off' }]);
    await fetchFeed(feedId);
    expect(await feedRow(feedId)).toMatchObject({ etag: '"v1"', total_fetches: 1 });
    const articles = await owner.query(
      'SELECT count(*)::int AS n FROM feed_items WHERE feed_id = $1',
      [feedId],
    );

    await fetchFeed(feedId);
    expect(conditional).toBe('"v1"');
    expect(await feedRow(feedId)).toMatchObject({
      etag: '"v1"',
      total_fetches: 2,
      consecutive_errors: 0,
      last_error_code: null,
    });
    const again = await owner.query(
      'SELECT count(*)::int AS n FROM feed_items WHERE feed_id = $1',
      [feedId],
    );
    expect(again.rows).toEqual(articles.rows);
  });

  it('defers a feed whose origin is cooling down without counting a failure', async () => {
    const feedId = await addFeed('/cooldown/feed.rss', [{ user: reader, mode: 'off' }]);
    server.route(
      '/cooldown/feed.rss',
      rssRoute(() => rss('Cooldown', '')),
    );
    const limiter = createMemoryOriginLimiter({ spacingMs: 0 });
    const until = new Date(Date.now() + 3_600_000);
    await limiter.block(server.origin, until);
    const before = server.requests.length;

    await fetchFeed(feedId, createHandlers(workerDeps(limiter)));

    const row = await feedRow(feedId);
    expect(row).toMatchObject({ total_fetches: 0, consecutive_errors: 0, last_error_code: null });
    expect(row.next_fetch_at.getTime()).toBeGreaterThanOrEqual(until.getTime() - 1000);
    expect(server.requests.length).toBe(before);
  });

  it('merges a feed redirected permanently to another feed and continues its moved articles', async () => {
    server.route('/merge/x.html', html(articlePage('Merged story')));
    server.route(
      '/merge/old.rss',
      rssRoute(() => rss('Old', rssItem('x-1', 'Merged story', server.url('/merge/x.html')))),
    );
    server.route(
      '/merge/new.rss',
      rssRoute(() => rss('New', rssItem('y-1', 'Target story', server.url('/merge/y.html')))),
    );
    const activeReader = await createUser(owner);
    const target = await addFeed('/merge/new.rss', [{ user: activeReader, mode: 'active' }]);
    const source = await addFeed('/merge/old.rss', [{ user: reader, mode: 'off' }]);
    await fetchFeed(source);
    const moved = await articleIdByUrl(server.url('/merge/x.html'));
    await run('article.extract');
    expect(await intents('article.enrich', moved)).toEqual([]); // only an off reader so far

    // The old feed URL now redirects permanently to the feed that already owns the new URL.
    server.redirect('/merge/old.rss', server.url('/merge/new.rss'), 301);
    await fetchFeed(source);

    const rows = await owner.query<{ id: string; merged_into_id: string | null; status: string }>(
      `SELECT id::text AS id, merged_into_id::text AS merged_into_id, status
         FROM feeds WHERE id = ANY($1::bigint[])`,
      [[source, target]],
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r]));
    expect(byId.get(source)).toMatchObject({ merged_into_id: target, status: 'dead' });
    expect(byId.get(target)).toMatchObject({ merged_into_id: null, status: 'active' });
    const carriers = await owner.query<{ feed_id: string }>(
      'SELECT feed_id::text AS feed_id FROM feed_items WHERE article_id = $1',
      [moved],
    );
    expect(carriers.rows).toEqual([{ feed_id: target }]);
    const subscriptions = await owner.query<{ feed_id: string }>(
      'SELECT feed_id::text AS feed_id FROM subscriptions WHERE user_id = $1 AND feed_id = ANY($2::bigint[])',
      [reader.id, [source, target]],
    );
    expect(subscriptions.rows).toEqual([{ feed_id: target }]);
    // The new association's active reader creates the demand the off reader never did, and the
    // survivor's subscribers are ranked; the same fetch ingested the survivor's own items.
    expect(await intents('article.enrich', moved)).toHaveLength(1);
    expect((await intents('user.rank')).map((p) => p['userId'])).toContain(activeReader.id);
    expect(await articleIdByUrl(server.url('/merge/y.html'))).toBeTruthy();
  });

  it('sets lang_hint from <language>, else from ≥ 70 % of 20 detected articles', async () => {
    server.route(
      '/lang/sk.rss',
      rssRoute(() =>
        rss('Slovensky', rssItem('sk-1', 'Električky', server.url('/lang/1.html')), 'sk-SK'),
      ),
    );
    const declared = await addFeed('/lang/sk.rss', [{ user: reader, mode: 'off' }]);
    await fetchFeed(declared);
    expect((await feedRow(declared)).lang_hint).toBe('sk');

    // A linkless JSON Feed without `language`: its articles are extracted from their feed text.
    const notes = Array.from({ length: 20 }, (_, i) => ({
      id: `note-${i}`,
      title: `Energy note ${i}`,
      content_html:
        `<p>Note ${i}: this week the grid ran on renewable electricity for more than half of all ` +
        'hours, and operators kept the gas plants on standby for the evening peak only.</p>',
      date_published: new Date(Date.now() - (i + 1) * 3_600_000).toISOString(),
    }));
    server.route('/lang/notes.json', () => ({
      status: 200,
      headers: { 'content-type': 'application/feed+json' },
      body: JSON.stringify({
        version: 'https://jsonfeed.org/version/1.1',
        title: 'Notes',
        items: notes,
      }),
    }));
    const detected = await addFeed('/lang/notes.json', [{ user: reader, mode: 'off' }]);
    await fetchFeed(detected);
    expect((await feedRow(detected)).lang_hint).toBeNull();
    await run('article.extract');
    const langs = await owner.query<{ lang: string; n: number }>(
      `SELECT a.lang, count(*)::int AS n FROM feed_items fi JOIN articles a ON a.id = fi.article_id
        WHERE fi.feed_id = $1 GROUP BY a.lang`,
      [detected],
    );
    expect(langs.rows).toEqual([{ lang: 'en', n: 20 }]);
    await fetchFeed(detected);
    expect((await feedRow(detected)).lang_hint).toBe('en');
  });
});

describe('article.extract (M1-T7)', () => {
  it('aliases a redirect and a same-site rel=canonical, then advances through after(extract)', async () => {
    server.redirect('/go/one', server.url('/stories/one.html'), 302);
    server.route('/stories/one.html', html(articlePage('Story one')));
    server.route(
      '/amp/two.html',
      html(articlePage('Story two', { canonical: server.url('/stories/two.html') })),
    );
    server.route(
      '/alias/feed.rss',
      rssRoute(() =>
        rss(
          'Aliases',
          rssItem('a-1', 'Story one', server.url('/go/one')) +
            rssItem('a-2', 'Story two', server.url('/amp/two.html')),
        ),
      ),
    );
    const feedId = await addFeed('/alias/feed.rss', [{ user: reader, mode: 'active' }]);
    await fetchFeed(feedId);
    const one = await articleIdByUrl(server.url('/go/one'));
    const two = await articleIdByUrl(server.url('/amp/two.html'));
    await run('article.extract');

    const aliases = await owner.query<{ article_id: string; url_key: string; source: string }>(
      `SELECT article_id::text AS article_id, url_key, source FROM article_aliases
        WHERE article_id = ANY($1::bigint[]) ORDER BY article_id`,
      [[one, two]],
    );
    expect(aliases.rows).toEqual([
      { article_id: one, url_key: keyOf(server.url('/stories/one.html')), source: 'redirect' },
      { article_id: two, url_key: keyOf(server.url('/stories/two.html')), source: 'rel_canonical' },
    ]);
    const rows = await owner.query<{
      id: string;
      pipeline_state: string;
      lang: string;
      status: string;
    }>(
      `SELECT a.id::text AS id, a.pipeline_state, a.lang, b.status
         FROM articles a JOIN article_bodies b ON b.article_id = a.id
        WHERE a.id = ANY($1::bigint[]) ORDER BY a.id`,
      [[one, two]],
    );
    expect(rows.rows.map((r) => ({ ...r }))).toEqual([
      { id: one, pipeline_state: 'extracted', lang: 'en', status: 'ok' },
      { id: two, pipeline_state: 'extracted', lang: 'en', status: 'ok' },
    ]);
    // after('extract') with an active reader: English is native, so enrichment is next.
    expect(await intents('article.enrich', one)).toHaveLength(1);
    expect(await intents('article.enrich', two)).toHaveLength(1);
  });

  it('merges into the article that owns the rel=canonical URL and continues the new carrier', async () => {
    server.route('/stories/three.html', html(articlePage('Story three')));
    server.route(
      '/amp/three.html',
      html(articlePage('Story three', { canonical: server.url('/stories/three.html') })),
    );
    server.route(
      '/owner/feed.rss',
      rssRoute(() =>
        rss('Owner', rssItem('o-3', 'Story three', server.url('/stories/three.html'))),
      ),
    );
    server.route(
      '/amp/feed.rss',
      rssRoute(() => rss('AMP', rssItem('amp-3', 'Story three', server.url('/amp/three.html')))),
    );
    const ownerFeed = await addFeed('/owner/feed.rss', [{ user: reader, mode: 'off' }]);
    const active = await createUser(owner);
    const ampFeed = await addFeed('/amp/feed.rss', [{ user: active, mode: 'active' }]);
    await fetchFeed(ownerFeed);
    const survivor = await articleIdByUrl(server.url('/stories/three.html'));
    await run('article.extract');
    expect(await intents('article.enrich', survivor)).toEqual([]); // only an off reader so far

    await fetchFeed(ampFeed);
    const amp = await articleIdByUrl(server.url('/amp/three.html'));
    await run('article.extract');

    const gone = await owner.query('SELECT 1 FROM articles WHERE id = $1', [amp]);
    expect(gone.rowCount).toBe(0);
    const alias = await owner.query<{ article_id: string }>(
      'SELECT article_id::text AS article_id FROM article_aliases WHERE url_key = $1',
      [keyOf(server.url('/amp/three.html'))],
    );
    expect(alias.rows).toEqual([{ article_id: survivor }]);
    const carriers = await owner.query<{ feed_id: string }>(
      'SELECT feed_id::text AS feed_id FROM feed_items WHERE article_id = $1 ORDER BY feed_id',
      [survivor],
    );
    expect(carriers.rows.map((r) => r.feed_id)).toEqual([ownerFeed, ampFeed].sort());
    // The moved carrier's active reader creates the demand the off reader never did.
    expect(await intents('article.enrich', survivor)).toHaveLength(1);
    const ranked = (await intents('user.rank')).map((p) => p['userId']);
    expect(ranked).toContain(active.id);
  });
});

describe('article.capture-bookmark (M1-T7)', () => {
  async function ingestOne(path: string, title: string, link: string): Promise<string> {
    server.route(
      path,
      rssRoute(() => rss(title, rssItem(`${path}-1`, title, link))),
    );
    const feedId = await addFeed(path, [{ user: reader, mode: 'off' }]);
    await fetchFeed(feedId);
    return articleIdByUrl(link);
  }

  it('saves a complete extracted body without a new request', async () => {
    server.route('/capture/done.html', html(articlePage('Captured story')));
    const id = await ingestOne(
      '/capture/done.rss',
      'Captured story',
      server.url('/capture/done.html'),
    );
    await run('article.extract');
    const before = server.requests.length;
    expect(await bookmark(reader, id)).toBe('saved');
    expect(await run('article.capture-bookmark')).toBe(0);
    expect(server.requests.length).toBe(before);
    expect(await capture(reader, id)).toMatchObject({
      status: 'saved',
      completeness: 'complete',
      source: 'page',
    });
  });

  it('fetches and extracts the page for a bookmark saved before extraction', async () => {
    server.route('/capture/fresh.html', html(articlePage('Fresh story')));
    const id = await ingestOne(
      '/capture/fresh.rss',
      'Fresh story',
      server.url('/capture/fresh.html'),
    );
    expect(await bookmark(reader, id)).toBe('pending');
    // The linked item's feed text is its interim body: a partial feed snapshot until the page is read.
    expect(await capture(reader, id)).toMatchObject({
      status: 'pending',
      completeness: 'partial',
      reason: 'feed_content',
      source: 'feed',
    });
    expect(await run('article.capture-bookmark')).toBe(1);
    const saved = await capture(reader, id);
    expect(saved).toMatchObject({ status: 'saved', completeness: 'complete', source: 'page' });
    expect(saved.text).toContain('Fresh story, part 6.');
    // Capture never creates model demand.
    for (const queue of ['article.translate', 'article.enrich', 'article.match']) {
      expect(await intents(queue, id)).toEqual([]);
    }
  });

  it('keeps the feed text as a terminal partial snapshot when the page cannot be read', async () => {
    server.route('/capture/gone.html', { status: 404, body: 'gone' });
    const id = await ingestOne('/capture/gone.rss', 'Gone story', server.url('/capture/gone.html'));
    expect(await bookmark(reader, id)).toBe('pending');
    await run('article.capture-bookmark');
    expect(await capture(reader, id)).toMatchObject({
      status: 'partial',
      error: null,
      completeness: 'partial',
      reason: 'feed_content',
      source: 'feed',
      text: 'Gone story: the summary from the feed.',
    });
  });
});
