import {
  MIGRATIONS_FOLDER,
  PG_BOSS_VERSION,
  claimOutboxIntents,
  completeOutboxIntent,
  countArticles,
  createDatabase,
  failOutboxIntent,
  listArticlePage,
  runMigrations,
  withTenant,
  type Database,
} from '@bantoozi/db';
import { createMemoryOriginLimiter } from '@bantoozi/feeds';
import { parseJobPayload, type QueueName } from '@bantoozi/shared';
import type { CredentialResolver } from '@bantoozi/shared/server';
import {
  FAKE_TYPESAFE_MODEL,
  createSubscription,
  createUser,
  dropCreatedTestDatabases,
  fixturePath,
  setupTestDatabase,
  startFakeLibreTranslate,
  startFakeOllama,
  startFakeTypeSafe,
  startFixtureServer,
  type FakeLibreTranslate,
  type FakeOllamaServer,
  type FakeTypeSafeServer,
  type FixtureServer,
  type TestDatabase,
} from '@bantoozi/testing';
import { createLibreTranslateClient, createOllamaTranslator } from '@bantoozi/translate';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TranslationDeps } from '../src/classify/translation.js';
import { createWorkerCredentialResolver } from '../src/credentials/index.js';
import { CredentialUnavailableError } from '../src/credentials/resolver.js';
import { createWorkerEngineRouter } from '../src/engine-router.js';
import { createWorkerDeps } from '../src/handlers/deps.js';
import { createHandlers, dispatch, type HandlerMap } from '../src/handlers/index.js';
import { defaultSeedHooks, runSeed } from '../src/seed.js';

/**
 * Launch checklist item 13 (spec 11 §9, spec 03 §10): with every subscription off, ingestion,
 * extraction, reading and a bookmark capture make no external model call. The real handlers, the
 * real engine router and real translators are wired to the fake TypeSafe, LLM (Ollama) and
 * LibreTranslate servers, which record every request; all three stay at zero and `engine_calls`
 * stays empty.
 */

const QUIET = { info: () => {}, warn: () => {}, error: () => {} };
const SETTINGS_ENV = {
  dailyBudgetUsd: 2,
  languageModes: { en: 'native', sk: 'translate', cs: 'native' },
  signupMode: 'invite',
} as const;
/** Every stage that could reach a model, plus the ingestion stages this test runs. */
const RUNNABLE: readonly QueueName[] = [
  'feed.fetch',
  'article.extract',
  'article.capture-bookmark',
  'article.translate',
  'article.enrich',
  'article.cluster',
  'article.match',
  'card.backfill',
];

let testDb: TestDatabase;
let owner: pg.Pool;
let appPool: pg.Pool;
let workerPool: pg.Pool;
let lockPool: pg.Pool;
let db: Database;
let appDb: Database;
let server: FixtureServer;
let typesafe: FakeTypeSafeServer;
let ollama: FakeOllamaServer;
let libre: FakeLibreTranslate;
let handlers: HandlerMap;
let userId: string;
let feedId: string;

async function drain(): Promise<{ ran: string[]; kept: string[] }> {
  const ran: string[] = [];
  const kept: string[] = [];
  for (;;) {
    const claimed = await claimOutboxIntents(db, { limit: 100, leaseSeconds: 120 });
    if (claimed.length === 0) return { ran, kept };
    let progressed = false;
    for (const intent of claimed) {
      if (!(RUNNABLE as readonly string[]).includes(intent.queue)) {
        kept.push(intent.queue);
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
    if (!progressed) return { ran, kept };
  }
}

const externalRequests = () => ({
  typesafe: typesafe.requestCount(),
  ollama: ollama.requests.length,
  libretranslate: libre.requests.length,
});

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
  appPool = new pg.Pool({ connectionString: testDb.urls.app, max: 3 });
  workerPool = new pg.Pool({ connectionString: testDb.urls.worker, max: 8 });
  lockPool = new pg.Pool({ connectionString: testDb.urls.worker, max: 2 });
  db = createDatabase(workerPool);
  appDb = createDatabase(appPool);
  await runSeed(db, SETTINGS_ENV, defaultSeedHooks());

  server = await startFixtureServer({ root: fixturePath('ingestion') });
  typesafe = await startFakeTypeSafe({ apiKey: 'k' });
  ollama = await startFakeOllama({ apiKey: 'k' });
  libre = await startFakeLibreTranslate();
  const credentials = createWorkerCredentialResolver({
    db,
    masterKeyId: undefined,
    masterKeys: undefined,
    envKeys: { typesafe: 'k' },
  });
  const router = createWorkerEngineRouter({
    db,
    config: {
      nodeEnv: 'test',
      typesafeBaseUrl: typesafe.url,
      typesafeModel: FAKE_TYPESAFE_MODEL,
      typesafePricePerMtokUsd: 0.5,
      engineConcurrency: 4,
      dailyBudgetUsd: SETTINGS_ENV.dailyBudgetUsd,
      ollamaBaseUrl: ollama.url,
      ollamaModelFast: 'fast',
      ollamaModelStrong: 'strong',
      ollamaMaxConcurrency: 1,
      llmFallbackEnabled: true,
    },
    credentials,
    logger: QUIET,
  });
  const ollamaCredentials: CredentialResolver = {
    metadata: async () => ({ source: 'env', enabled: true }),
    useActive: async () => {
      throw new CredentialUnavailableError('ollama', 'none');
    },
    useCandidate: async () => {
      throw new Error('candidate keys are not used here');
    },
  };
  const translation: TranslationDeps = {
    libretranslate: createLibreTranslateClient({ baseUrl: libre.url, maxAttempts: 1 }),
    ollama: createOllamaTranslator({ baseUrl: ollama.url }),
    credentials: ollamaCredentials,
    modelFast: 'fast',
    modelStrong: 'strong',
  };
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
      settingsEnv: SETTINGS_ENV,
      limiter: createMemoryOriginLimiter({ spacingMs: 0 }),
      logger: QUIET,
      classification: {
        router,
        primaryModel: FAKE_TYPESAFE_MODEL,
        leaseMs: 120_000,
        callDeadlineMs: 30_000,
        jobBudgetMs: 600_000,
        translation,
      },
    }),
  );

  const pubDate = new Date(Date.now() - 86_400_000).toUTCString();
  server.route('/feeds/off.rss', () => ({
    status: 200,
    headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
    body: `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>Off Feed</title><link>${server.url('/')}</link>
<description>Off</description><language>en</language>
<item><title>Solid-state batteries move from the lab to the pilot line</title>
<link>${server.url('/pages/battery.html')}</link><guid>off-battery</guid><pubDate>${pubDate}</pubDate>
<description>Three manufacturers start pilot production.</description></item>
<item><title>Nové električky v Bratislave jazdia od pondelka</title>
<link>${server.url('/pages/tram.html')}</link><guid>off-tram</guid><pubDate>${pubDate}</pubDate>
<description>Od pondelka jazdia prvé nové električky.</description></item>
</channel></rss>`,
  }));
  const url = server.url('/feeds/off.rss');
  feedId = (
    await owner.query<{ id: string }>(
      'INSERT INTO feeds (url, fetch_url) VALUES ($1, $1) RETURNING id::text AS id',
      [url],
    )
  ).rows[0]!.id;
  userId = (await createUser(owner)).id;
  await createSubscription(owner, { userId, feedId, mode: 'off' });
  await owner.query('SELECT refresh_feed_subscribers($1::bigint[], $2::jsonb)', [
    [feedId],
    JSON.stringify({ beta: 900, admin: 300 }),
  ]);
  await owner.query('SELECT refresh_feed_cards($1::bigint[])', [[feedId]]);
}, 120_000);

afterAll(async () => {
  await server?.close();
  await typesafe?.close();
  await ollama?.close();
  await libre?.close();
  await Promise.all([owner?.end(), appPool?.end(), workerPool?.end(), lockPool?.end()]);
  await dropCreatedTestDatabases();
});

describe('all subscriptions off (spec 11 §9 item 13)', () => {
  it('makes no TypeSafe, LLM or LibreTranslate call and records no engine call', async () => {
    // Ingestion: fetch the feed, extract both pages.
    await dispatch(
      handlers,
      'feed.fetch',
      { feedId, force: true },
      { queue: 'feed.fetch', jobId: 'off' },
    );
    const first = await drain();
    expect(first.ran.filter((q) => q === 'article.extract')).toHaveLength(2);
    const extracted = await owner.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM articles WHERE pipeline_state = 'extracted'",
    );
    expect(extracted.rows[0]?.n).toBe(2);
    // The off subscription creates no inference demand: no model stage was even queued.
    for (const queue of ['article.translate', 'article.enrich', 'article.match', 'card.backfill']) {
      expect(first.ran).not.toContain(queue);
    }

    // Reading through the db read functions as the user.
    const asOf = new Date();
    const read = await withTenant(appDb, userId, async (tx) => {
      const view = { scope: {}, status: 'all', minTier: 0, asOf, scoreVersion: 'v0' } as const;
      const lists = [];
      for (const lane of ['for_you', 'maybe', 'everything', 'new', 'all'] as const) {
        lists.push(
          await listArticlePage(tx, { ...view, lane, sort: 'date', limit: 20, after: null }),
        );
      }
      const counts = await countArticles(tx, view);
      return { lists, counts };
    });
    expect(read.lists.map((l) => l.rows.length)).toEqual([0, 0, 0, 2, 2]);
    const all = read.lists[4]!;
    expect(all.rows.length).toBe(2);
    expect(read.counts.new).toBe(2);

    // A bookmark and its snapshot capture.
    const articleId = all.rows[0]!.articleId;
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
      await client.query('SELECT * FROM capture_bookmark_snapshot($1, NULL)', [articleId]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    await drain();
    const bookmark = await owner.query<{ status: string | null }>(
      'SELECT bookmark_capture_status AS status FROM user_article WHERE user_id = $1 AND article_id = $2',
      [userId, articleId],
    );
    expect(['saved', 'partial']).toContain(bookmark.rows[0]?.status);

    // Zero calls everywhere.
    expect(externalRequests()).toEqual({ typesafe: 0, ollama: 0, libretranslate: 0 });
    const calls = await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM engine_calls');
    expect(calls.rows[0]?.n).toBe(0);
  });
});
