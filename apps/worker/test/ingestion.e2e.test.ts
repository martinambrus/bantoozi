import {
  MIGRATIONS_FOLDER,
  PG_BOSS_VERSION,
  claimOutboxIntents,
  completeOutboxIntent,
  createDatabase,
  failOutboxIntent,
  runMigrations,
  saveExtractionResult,
  workerOutbox,
  type Database,
} from '@bantoozi/db';
import { createMemoryOriginLimiter } from '@bantoozi/feeds';
import { parseJobPayload, type QueueName } from '@bantoozi/shared';
import {
  createCard,
  createSubscription,
  createUser,
  dropCreatedTestDatabases,
  fixturePath,
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
 * M1-T8 (spec 03, PLAN §6): ingestion end to end against a real migrated database and the local
 * fixture server. Three feeds (RSS, Atom, JSON Feed), two of which share an article, plus article
 * pages, run through the real handlers: feed.fetch → article.extract (and the pipeline's demand
 * gate), with a Google-News-style redirect merge, stale items, off/active subscriptions and reader
 * state that must survive the merge. Later stages (translate, enrich, match, rank) are M2+ stubs:
 * their durable intents are asserted, never executed.
 */

const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();
const rfc822 = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toUTCString();

let testDb: TestDatabase;
let owner: pg.Pool;
let appPool: pg.Pool;
let workerPool: pg.Pool;
let lockPool: pg.Pool;
let db: Database;
let server: FixtureServer;
let handlers: HandlerMap;

/** Mutable feed scripts: tests change titles and items between fetches. */
const script = {
  batteryTitle: 'Solid-state batteries move from the lab to the pilot line',
};

let users: { u1: UserFixture; u2: UserFixture; u3: UserFixture; u4: UserFixture };
const feeds: Record<'news' | 'blog' | 'items' | 'active' | 'other', string> = {
  news: '',
  blog: '',
  items: '',
  active: '',
  other: '',
};

function page(name: string): string {
  return server.url(`/pages/${name}.html`);
}

/** F1: RSS 2.0 with an ETag; carries battery, charging, a Google-News wrapper and a stale item. */
function newsRss(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel>
<title>Example News</title><link>${server.url('/')}</link><description>News</description>
<language>en</language>
<item><title>${script.batteryTitle}</title><link>${page('battery')}</link>
<guid>battery-1</guid><pubDate>${rfc822(1)}</pubDate>
<description>Three manufacturers start pilot production of solid-state cells.</description></item>
<item><title>Motorway charging network doubles its capacity</title><link>${page('charging')}</link>
<guid>charging-1</guid><pubDate>${rfc822(2)}</pubDate>
<description>Every service area now offers at least eight fast chargers.</description></item>
<item><title>Nové električky v Bratislave (Google News)</title>
<link>${server.url('/rss/articles/CBMiTramWrapper')}?oc=5</link>
<guid>gn-tram</guid><pubDate>${rfc822(1)}</pubDate>
<description>Nové nízkopodlažné električky jazdia od pondelka.</description></item>
<item><title>An old announcement</title><link>${page('old')}</link>
<guid>old-1</guid><pubDate>${rfc822(60)}</pubDate><description>From two months ago.</description></item>
</channel></rss>`;
}

/** F2: Atom; shares the charging article with F1 and carries the Slovak tram article. */
function blogAtom(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>City Blog</title><id>urn:example:blog</id><updated>${iso(1)}</updated>
<link rel="alternate" type="text/html" href="${server.url('/blog')}"/>
<entry><title>Motorway charging network doubles its capacity</title>
<link rel="alternate" type="text/html" href="${page('charging')}"/>
<id>urn:example:blog:charging</id><updated>${iso(2)}</updated><published>${iso(2)}</published>
<summary>A syndicated summary that must not replace the source feed's inputs.</summary></entry>
<entry><title>Nové električky v Bratislave jazdia od pondelka</title>
<link rel="alternate" type="text/html" href="${page('tram')}"/>
<id>urn:example:blog:tram</id><updated>${iso(1)}</updated><published>${iso(1)}</published>
<summary>Od pondelka jazdia na petržalskej trati prvé nové električky.</summary></entry>
</feed>`;
}

/** F3: JSON Feed 1.1; a heat-pump article and a linkless note with its full text in the feed. */
function itemsJson(): string {
  return JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1',
    title: 'Energy Notes',
    home_page_url: server.url('/notes'),
    items: [
      {
        id: 'heatpump-1',
        url: page('heatpump'),
        title: 'Heat pumps outsell gas boilers for the first time',
        summary: 'Installers sold more heat pumps than gas boilers during a full quarter.',
        date_published: iso(1),
      },
      {
        id: 'note-1',
        title: 'Weekly energy note',
        content_html:
          '<p>This week the grid ran on renewable electricity for more than half of all hours, ' +
          'a record for the season. Wind farms in the north produced more than expected, and ' +
          'solar output stayed high thanks to a dry and sunny autumn. Operators kept the gas ' +
          'plants on standby for the evening peak only, when demand from heating starts to rise.</p>',
        date_published: iso(1),
      },
    ],
  });
}

/** F4: an ACTIVE feed newly carrying the already matched battery and the extracted heat-pump article. */
function activeRss(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>Active Picks</title><link>${server.url('/picks')}</link>
<description>Picks</description>
<item><title>${script.batteryTitle}</title><link>${page('battery')}</link><guid>p-battery</guid>
<pubDate>${rfc822(1)}</pubDate><description>Picked: battery.</description></item>
<item><title>Heat pumps outsell gas boilers for the first time</title><link>${page('heatpump')}</link>
<guid>p-heatpump</guid><pubDate>${rfc822(1)}</pubDate><description>Picked: heat pumps.</description></item>
</channel></rss>`;
}

/** F5: an OFF feed newly carrying the battery article. */
function otherRss(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>Other</title><link>${server.url('/other')}</link>
<description>Other</description>
<item><title>${script.batteryTitle}</title><link>${page('battery')}</link><guid>o-battery</guid>
<pubDate>${rfc822(1)}</pubDate><description>Another summary.</description></item>
</channel></rss>`;
}

async function addFeed(path: string): Promise<string> {
  const url = server.url(path);
  const result = await owner.query<{ id: string }>(
    'INSERT INTO feeds (url, fetch_url) VALUES ($1, $1) RETURNING id::text AS id',
    [url],
  );
  return result.rows[0]!.id;
}

async function refreshFeeds(ids: string[]): Promise<void> {
  await owner.query('SELECT refresh_feed_subscribers($1::bigint[], $2::jsonb)', [
    ids,
    JSON.stringify({ beta: 900, admin: 300 }),
  ]);
  await owner.query('SELECT refresh_feed_cards($1::bigint[])', [ids]);
}

async function fetchFeed(feedId: string): Promise<void> {
  await dispatch(
    handlers,
    'feed.fetch',
    { feedId, force: true },
    { queue: 'feed.fetch', jobId: 'e2e' },
  );
}

/**
 * Run the pending intents of the implemented `queues` through their real handlers until none is
 * left (a deterministic stand-in for the relay and pg-boss). Other intents, and those `skip`
 * selects, are kept undelivered and pushed a day out, so their existence can be asserted.
 */
async function drain(
  queues: readonly QueueName[],
  skip: (queue: string, payload: Record<string, unknown>) => boolean = () => false,
): Promise<number> {
  let ran = 0;
  for (;;) {
    const claimed = await claimOutboxIntents(db, { limit: 100, leaseSeconds: 120 });
    if (claimed.length === 0) return ran;
    let progressed = false;
    for (const intent of claimed) {
      const payload = intent.payload as Record<string, unknown>;
      if (!(queues as readonly string[]).includes(intent.queue) || skip(intent.queue, payload)) {
        await failOutboxIntent(db, intent, { error: 'e2e_kept', retryInSeconds: 86_400 });
        continue;
      }
      const queue = intent.queue as QueueName;
      await dispatch(handlers, queue, parseJobPayload(queue, payload), { queue, jobId: intent.id });
      await completeOutboxIntent(db, intent);
      ran += 1;
      progressed = true;
    }
    if (!progressed) return ran;
  }
}

/** Undelivered intents of a queue (payloads), e.g. the M2 stages the pipeline recorded. */
async function pendingIntents(queue: string): Promise<Array<Record<string, unknown>>> {
  const result = await owner.query<{ payload: Record<string, unknown> }>(
    'SELECT payload FROM job_outbox WHERE queue = $1 AND delivered_at IS NULL ORDER BY id',
    [queue],
  );
  return result.rows.map((r) => r.payload);
}

async function everIntents(queue: string): Promise<Array<Record<string, unknown>>> {
  const result = await owner.query<{ payload: Record<string, unknown> }>(
    'SELECT payload FROM job_outbox WHERE queue = $1 ORDER BY id',
    [queue],
  );
  return result.rows.map((r) => r.payload);
}

async function articleByUrl(url: string) {
  const result = await owner.query<{
    id: string;
    pipeline_state: string;
    lang: string | null;
    content_revision: string;
    title: string;
  }>(
    `SELECT a.id::text AS id, a.pipeline_state, a.lang, a.content_revision::text AS content_revision, a.title
       FROM articles a WHERE a.url_key = $1
     UNION ALL
     SELECT a.id::text, a.pipeline_state, a.lang, a.content_revision::text, a.title
       FROM article_aliases al JOIN articles a ON a.id = al.article_id WHERE al.url_key = $1`,
    [url],
  );
  return result.rows;
}

async function carriers(articleId: string): Promise<string[]> {
  const result = await owner.query<{ feed_id: string }>(
    'SELECT feed_id::text AS feed_id FROM feed_items WHERE article_id = $1 ORDER BY feed_id',
    [articleId],
  );
  return result.rows.map((r) => r.feed_id);
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

  server = await startFixtureServer({ root: fixturePath('ingestion') });
  const xml = (body: () => string, type: string, etag?: string) => () => ({
    status: 200,
    headers: { 'content-type': type, ...(etag === undefined ? {} : { etag }) },
    body: body(),
  });
  server.route('/feeds/news.rss', xml(newsRss, 'application/rss+xml; charset=utf-8', '"news-v1"'));
  server.route('/feeds/blog.atom', xml(blogAtom, 'application/atom+xml; charset=utf-8'));
  server.route('/feeds/items.json', xml(itemsJson, 'application/feed+json'));
  server.route('/feeds/active.rss', xml(activeRss, 'application/rss+xml; charset=utf-8'));
  server.route('/feeds/other.rss', xml(otherRss, 'application/rss+xml; charset=utf-8'));
  // Google-News-style wrapper: a permanent redirect to the publisher's page (query ignored).
  server.redirect('/rss/articles/CBMiTramWrapper', page('tram'), 301);

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
      // One fixture origin: politeness spacing is proven by the limiter tests, not here.
      limiter: createMemoryOriginLimiter({ spacingMs: 0 }),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    }),
  );

  users = {
    u1: await createUser(owner),
    u2: await createUser(owner),
    u3: await createUser(owner),
    u4: await createUser(owner),
  };
  feeds.news = await addFeed('/feeds/news.rss');
  feeds.blog = await addFeed('/feeds/blog.atom');
  feeds.items = await addFeed('/feeds/items.json');
  for (const feedId of [feeds.news, feeds.blog, feeds.items]) {
    await createSubscription(owner, { userId: users.u1.id, feedId, mode: 'off' });
  }
  await createSubscription(owner, { userId: users.u2.id, feedId: feeds.blog, mode: 'off' });
  await refreshFeeds([feeds.news, feeds.blog, feeds.items]);
});

afterAll(async () => {
  await server?.close();
  await Promise.all([owner?.end(), appPool?.end(), workerPool?.end(), lockPool?.end()]);
  await dropCreatedTestDatabases();
});

describe('ingestion end to end (M1-T8)', () => {
  let wrapperId = '';

  it('fetches three feeds (RSS, Atom, JSON Feed) and stores a shared article once', async () => {
    for (const feedId of [feeds.news, feeds.blog, feeds.items]) await fetchFeed(feedId);
    const charging = await articleByUrl(page('charging'));
    expect(charging).toHaveLength(1);
    expect(await carriers(charging[0]!.id)).toEqual([feeds.news, feeds.blog].sort());
    // The source feed (first seen, then lower id) keeps its inputs; the Atom summary is not stored.
    const excerpt = await owner.query('SELECT excerpt FROM articles WHERE id = $1', [
      charging[0]!.id,
    ]);
    expect(excerpt.rows[0]).toEqual({
      excerpt: 'Every service area now offers at least eight fast chargers.',
    });
    const wrapper = await articleByUrl(`${server.url('/rss/articles/CBMiTramWrapper')}?oc=5`);
    expect(wrapper).toHaveLength(1);
    wrapperId = wrapper[0]!.id;
    const count = await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM articles');
    expect(count.rows[0]!.n).toBe(7); // battery, charging, wrapper, old, tram, heatpump, note
  });

  it('updates feed stats, validators and the next fetch time', async () => {
    const result = await owner.query<{
      id: string;
      total_fetches: number;
      consecutive_errors: number;
      last_success_at: Date | null;
      next_after_now: boolean;
      etag: string | null;
      gaps: unknown;
      lang_hint: string | null;
      title: string | null;
    }>(
      `SELECT id::text AS id, total_fetches, consecutive_errors, last_success_at,
              next_fetch_at > now() AS next_after_now, etag, publish_stats->'recent_gaps_s' AS gaps,
              lang_hint, title
         FROM feeds WHERE id = ANY($1::bigint[]) ORDER BY id`,
      [[feeds.news, feeds.blog, feeds.items]],
    );
    for (const row of result.rows) {
      expect(row).toMatchObject({ total_fetches: 1, consecutive_errors: 0, next_after_now: true });
      expect(row.last_success_at).not.toBeNull();
      expect(Array.isArray(row.gaps)).toBe(true);
    }
    const news = result.rows.find((r) => r.id === feeds.news)!;
    expect(news).toMatchObject({ etag: '"news-v1"', lang_hint: 'en', title: 'Example News' });
  });

  it('keeps stale items unextracted and records extraction for the fresh ones', async () => {
    const old = await articleByUrl(page('old'));
    expect(old[0]).toMatchObject({ pipeline_state: 'stale' });
    const extractIds = (await everIntents('article.extract')).map((p) => p['articleId']);
    expect(extractIds).not.toContain(old[0]!.id);
    expect(extractIds).toContain(wrapperId);
  });

  it('extracts bodies and detects languages; off subscriptions create no inference demand', async () => {
    // Everything except the Google-News wrapper, which is extracted after reader state exists.
    await drain(['article.extract'], (_q, p) => p['articleId'] === wrapperId);
    const rows = await owner.query<{
      url: string | null;
      pipeline_state: string;
      lang: string | null;
      status: string | null;
      extractor: string | null;
      word_count: number | null;
    }>(
      `SELECT a.url, a.pipeline_state, a.lang, b.status, b.extractor_version AS extractor, a.word_count
         FROM articles a LEFT JOIN article_bodies b ON b.article_id = a.id
        WHERE a.id <> $1 AND a.pipeline_state <> 'stale' ORDER BY a.id`,
      [wrapperId],
    );
    const byUrl = new Map(rows.rows.map((r) => [r.url, r]));
    for (const name of ['battery', 'charging', 'heatpump']) {
      expect(byUrl.get(page(name))).toMatchObject({
        pipeline_state: 'extracted',
        lang: 'en',
        status: 'ok',
        extractor: 'readability-v1',
      });
      expect(byUrl.get(page(name))!.word_count).toBeGreaterThan(100);
    }
    expect(byUrl.get(page('tram'))).toMatchObject({ pipeline_state: 'extracted', lang: 'sk' });
    // The linkless note uses its feed text: no page fetch, extraction still completes.
    expect(byUrl.get(null)).toMatchObject({
      pipeline_state: 'extracted',
      lang: 'en',
      status: 'ok',
      extractor: 'feed-v1',
    });
    // No inference: every subscription is off.
    for (const queue of [
      'article.translate',
      'article.enrich',
      'article.match',
      'article.cluster',
    ]) {
      expect(await everIntents(queue)).toEqual([]);
    }
  });

  it('queues only the demanded, unanswered cards when an active feed newly carries a matched article', async () => {
    const battery = (await articleByUrl(page('battery')))[0]!;
    // M2 stand-in: battery is matched, with a current primary answer for card k1.
    const [k1, k2, k3, k4, k5] = await Promise.all([
      createCard(owner),
      createCard(owner),
      createCard(owner),
      createCard(owner),
      createCard(owner),
    ]);
    const qs = await owner.query<{ sha: string }>(
      `INSERT INTO question_sets (kind, version, sha256, definition)
       VALUES ('match', 'match-e2e', repeat('e', 64), '{}') RETURNING sha256 AS sha`,
    );
    await owner.query(`UPDATE articles SET pipeline_state = 'matched' WHERE id = $1`, [battery.id]);
    await owner.query(
      `INSERT INTO card_answers (article_id, card_id, p, engine, question_set_sha, article_revision,
                                 state_sha256, card_input_sha256, state_variant)
       VALUES ($1, $2, 0.8, 'typesafe', $3, $4, 's', 'c', 'native')`,
      [battery.id, k1!.id, qs.rows[0]!.sha, battery.content_revision],
    );
    feeds.active = await addFeed('/feeds/active.rss');
    feeds.other = await addFeed('/feeds/other.rss');
    await createSubscription(owner, {
      userId: users.u3.id,
      feedId: feeds.active,
      mode: 'active',
      activatedAt: new Date(Date.now() - 60_000),
    });
    await createSubscription(owner, { userId: users.u3.id, feedId: feeds.other, mode: 'off' });
    await createSubscription(owner, { userId: users.u4.id, feedId: feeds.other, mode: 'off' });
    await owner.query(
      `INSERT INTO user_cards (user_id, card_id, strength, scope_feed_id) VALUES
         ($1, $2, 'like', NULL), ($1, $3, 'love', NULL), ($1, $4, 'like', $6),
         ($1, $5, 'like', $7), ($8, $9, 'like', NULL)`,
      [users.u3.id, k1!.id, k2!.id, k3!.id, k4!.id, feeds.active, feeds.other, users.u4.id, k5!.id],
    );
    await refreshFeeds([feeds.active, feeds.other]);

    await fetchFeed(feeds.active);
    await fetchFeed(feeds.other);
    const queued = await owner.query<{ card_id: string; article_revision: string }>(
      `SELECT card_id::text AS card_id, article_revision::text AS article_revision
         FROM match_queue WHERE article_id = $1 ORDER BY card_id`,
      [battery.id],
    );
    // k1 has a current answer (reused); k4 is scoped to the off feed; k5's holder is off.
    expect(queued.rows).toEqual(
      [k2!.id, k3!.id]
        .sort()
        .map((card_id) => ({ card_id, article_revision: battery.content_revision })),
    );
    expect((await pendingIntents('article.match')).map((p) => p['articleId'])).toEqual([
      battery.id,
    ]);
    // The off feed adds no provider demand for the battery article.
    expect(
      (await everIntents('article.enrich')).filter((p) => p['articleId'] === battery.id),
    ).toEqual([]);
  });

  it('records enrichment when an active feed newly carries an article that stopped at extraction', async () => {
    const heatpump = (await articleByUrl(page('heatpump')))[0]!;
    expect(heatpump.pipeline_state).toBe('extracted');
    expect((await pendingIntents('article.enrich')).map((p) => p['articleId'])).toEqual([
      heatpump.id,
    ]);
    // Every subscriber of a feed with new associations gets an incremental rank intent.
    const ranked = (await pendingIntents('user.rank')).map((p) => p['userId']);
    expect(new Set(ranked)).toEqual(new Set([users.u1.id, users.u2.id, users.u3.id, users.u4.id]));
  });

  it('merges a Google-News wrapper into the existing article without losing either reader’s state', async () => {
    const tram = (await articleByUrl(page('tram')))[0]!;
    // Reader state before the merge. u1 (F1) rated, labelled, read and bookmarked the wrapper and
    // opened the tram article; u2 (F2) disliked and labelled the tram article.
    const l1 = await createCard(owner, { kind: 'label', title: 'Transit' });
    const l2 = await createCard(owner, { kind: 'label', title: 'City' });
    await owner.query(
      `INSERT INTO user_labels (user_id, card_id, name) VALUES ($1, $2, 'Transit'), ($3, $4, 'City')`,
      [users.u1.id, l1.id, users.u2.id, l2.id],
    );
    await owner.query(
      `INSERT INTO user_article (user_id, article_id, rating, rated_at, read_at, label_ids, state_version)
       VALUES ($1, $2, 1, now() - interval '1 hour', now() - interval '1 hour', ARRAY[$3]::bigint[], 4)`,
      [users.u1.id, wrapperId, l1.id],
    );
    await owner.query(
      `INSERT INTO user_article (user_id, article_id, opened_at, state_version)
       VALUES ($1, $2, now() - interval '2 hours', 2)`,
      [users.u1.id, tram.id],
    );
    await owner.query(
      `INSERT INTO user_article (user_id, article_id, rating, reason, rated_at, label_ids, state_version)
       VALUES ($1, $2, -1, 'seen', now() - interval '30 minutes', ARRAY[$3]::bigint[], 7)`,
      [users.u2.id, tram.id, l2.id],
    );
    // A bookmark through the real API function, as the API role in u1's tenant transaction.
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.user_id', $1, true)", [users.u1.id]);
      await client.query('SELECT * FROM capture_bookmark_snapshot($1, NULL)', [wrapperId]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    // Now extract the wrapper: the redirect lands on the tram article's URL → merge.
    await owner.query(
      `UPDATE job_outbox SET available_at = now() WHERE delivered_at IS NULL AND queue = 'article.extract'`,
    );
    await drain(['article.extract', 'article.capture-bookmark']);
    const gone = await owner.query('SELECT 1 FROM articles WHERE id = $1', [wrapperId]);
    expect(gone.rowCount).toBe(0);
    const alias = await owner.query<{ article_id: string; source: string }>(
      `SELECT article_id::text AS article_id, source FROM article_aliases WHERE url_key = $1`,
      [`${server.url('/rss/articles/CBMiTramWrapper')}?oc=5`],
    );
    expect(alias.rows).toEqual([{ article_id: tram.id, source: 'redirect' }]);
    expect(await carriers(tram.id)).toEqual([feeds.news, feeds.blog].sort());

    const states = await owner.query<{
      user_id: string;
      rating: number | null;
      reason: string | null;
      read: boolean;
      opened: boolean;
      bookmarked: boolean;
      snapshot: boolean;
      labels: string[];
      state_version: string;
    }>(
      `SELECT user_id::text AS user_id, rating, reason, read_at IS NOT NULL AS read,
              opened_at IS NOT NULL AS opened, bookmarked_at IS NOT NULL AS bookmarked,
              bookmark_snapshot_id IS NOT NULL AS snapshot, label_ids::text[] AS labels,
              state_version::text AS state_version
         FROM user_article WHERE article_id = $1 ORDER BY user_id`,
      [tram.id],
    );
    const byUser = new Map(states.rows.map((r) => [r.user_id, r]));
    // u1: the wrapper's rating, label, read state and bookmark merged with its tram row.
    expect(byUser.get(users.u1.id)).toMatchObject({
      rating: 1,
      read: true,
      opened: true,
      bookmarked: true,
      snapshot: true,
      labels: [l1.id],
    });
    // The surviving version is past both inputs (max(4 + bookmark, 2) + 1), so an offline
    // action prepared against either pre-merge version is stale (STALE_STATE).
    expect(Number(byUser.get(users.u1.id)!.state_version)).toBeGreaterThan(4);
    // u2 had no row on the wrapper: its survivor row, dislike and label are untouched, so its
    // offline actions against version 7 stay valid.
    expect(byUser.get(users.u2.id)).toMatchObject({
      rating: -1,
      reason: 'seen',
      labels: [l2.id],
      state_version: '7',
    });
  });

  it('resolves old jobs and old identities to the survivor', async () => {
    const tram = (await articleByUrl(page('tram')))[0]!;
    // A late extraction job for the merged id is a successful no-op.
    await dispatch(
      handlers,
      'article.extract',
      { articleId: wrapperId },
      {
        queue: 'article.extract',
        jobId: 'late',
      },
    );
    // Re-fetching F1 resolves the wrapper URL through its alias: no new article.
    await fetchFeed(feeds.news);
    const wrapperKey = `${server.url('/rss/articles/CBMiTramWrapper')}?oc=5`;
    const direct = await owner.query('SELECT 1 FROM articles WHERE url_key = $1', [wrapperKey]);
    expect(direct.rowCount).toBe(0);
    expect((await articleByUrl(wrapperKey)).map((a) => a.id)).toEqual([tram.id]);
  });

  it('never lets an out-of-order extraction result overwrite a newer revision', async () => {
    const before = (await articleByUrl(page('battery')))[0]!;
    // The source feed corrects its title: the article gets a new revision and new extraction work.
    script.batteryTitle = 'Solid-state batteries enter pilot production in three factories';
    await fetchFeed(feeds.news);
    const after = (await articleByUrl(page('battery')))[0]!;
    expect(BigInt(after.content_revision)).toBe(BigInt(before.content_revision) + 1n);
    expect(after).toMatchObject({ pipeline_state: 'ingested', title: script.batteryTitle });
    // A slow worker still holding the old revision cannot publish its result.
    const late = await db.transaction((tx) =>
      saveExtractionResult(tx, workerOutbox(tx), {
        articleId: after.id,
        expectedRevision: before.content_revision,
        body: {
          status: 'ok',
          resolvedUrl: page('battery'),
          httpStatus: 200,
          bodyText: 'An outdated body',
          bodyHtml: '<p>An outdated body</p>',
          completeness: 'complete',
          completenessReason: null,
          bodyLead: 'An outdated body',
          extractorVersion: 'readability-v1',
          error: null,
        },
        lang: { lang: 'en', confidence: 0.9 },
        wordCount: 3,
        media: { videoEvidence: false, bodyImageCount: 0, pageBodyExamined: true },
      }),
    );
    expect(late).toEqual({ status: 'stale_revision', revision: after.content_revision });
    // The current extraction job still runs for the new revision.
    await drain(['article.extract']);
    const body = await owner.query<{ article_revision: string; body_text: string }>(
      'SELECT article_revision::text AS article_revision, body_text FROM article_bodies WHERE article_id = $1',
      [after.id],
    );
    expect(body.rows[0]!.article_revision).toBe(after.content_revision);
    expect(body.rows[0]!.body_text).not.toContain('An outdated body');
  });

  it('serializes fetches of one feed: a job that finds the feed locked is a no-op', async () => {
    const totalFetches = async () =>
      (
        await owner.query<{ n: number }>('SELECT total_fetches AS n FROM feeds WHERE id = $1', [
          feeds.blog,
        ])
      ).rows[0]!.n;
    const before = await totalFetches();
    const requests = () => server.requests.filter((r) => r.path === '/feeds/blog.atom').length;
    const sent = requests();
    // Another worker holds the per-feed fetch lock.
    const holder = await workerPool.connect();
    try {
      await holder.query(
        `SELECT pg_advisory_lock(hashtextextended('feed.fetch:' || $1::text, 0))`,
        [feeds.blog],
      );
      await fetchFeed(feeds.blog);
      expect(await totalFetches()).toBe(before);
      expect(requests()).toBe(sent);
    } finally {
      await holder.query(
        `SELECT pg_advisory_unlock(hashtextextended('feed.fetch:' || $1::text, 0))`,
        [feeds.blog],
      );
      holder.release();
    }
    // Once released, two concurrent jobs still store the shared article only once.
    await Promise.all([fetchFeed(feeds.blog), fetchFeed(feeds.blog)]);
    expect(await totalFetches()).toBeGreaterThan(before);
    expect(await articleByUrl(page('tram'))).toHaveLength(1);
  });
});
