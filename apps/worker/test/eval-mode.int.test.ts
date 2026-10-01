import {
  MIGRATIONS_FOLDER,
  PG_BOSS_VERSION,
  createDatabase,
  ensureEvalUser,
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
  type UserFixture,
} from '@bantoozi/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  assertWorkerMode,
  effectiveWorkerQueues,
  GoldenDatabaseError,
  INGEST_ONLY_QUEUES,
  startHeartbeat,
} from '../src/eval-mode.js';
import { createWorkerDeps } from '../src/handlers/deps.js';
import { createHandlers, dispatch, type HandlerMap } from '../src/handlers/index.js';

/**
 * M3a-T1 (spec 10 §2.1, D-96): a worker with `EVAL_INGEST_ONLY=true` stops after extraction, an
 * ordinary worker refuses a golden database (one holding the evaluation user), and every worker
 * records its mode in `settings['worker.heartbeat']`.
 */

const silent = { info: () => {}, warn: () => {}, error: () => {} };

let testDb: TestDatabase;
let owner: pg.Pool;
let workerPool: pg.Pool;
let lockPool: pg.Pool;
let db: Database;
let server: FixtureServer;
let reader: UserFixture;

function handlersFor(evalIngestOnly: boolean): HandlerMap {
  return createHandlers(
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
        languageModes: { en: 'native', sk: 'translate', cs: 'native' },
        signupMode: 'invite',
      },
      limiter: createMemoryOriginLimiter({ spacingMs: 0 }),
      logger: silent,
      ...(evalIngestOnly ? { evalIngestOnly: true } : {}),
    }),
  );
}

function page(title: string, lang: string): string {
  const text =
    lang === 'sk'
      ? 'Mestské zastupiteľstvo schválilo novú električkovú trať po dlhej verejnej diskusii a ' +
        'stavebné firmy začnú pracovať na severnom úseku budúcu jar. Obyvatelia žiadali tichšie ' +
        'vozidlá a častejšie spoje vo večerných hodinách aj cez víkendy.'
      : 'The city council approved the new tram line after a long public consultation, and ' +
        'construction crews will start work on the northern section next spring. Residents asked ' +
        'for quieter vehicles and more frequent service in the evenings.';
  const paragraphs = Array.from({ length: 6 }, (_, i) => `<p>${title} ${i + 1}. ${text}</p>`);
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${title}</title>
</head><body><article><h1>${title}</h1>${paragraphs.join('\n')}</article></body></html>`;
}

async function addFeed(path: string, lang: string, titles: string[]): Promise<string> {
  const items = titles
    .map((title, i) => {
      const link = server.url(`${path}/a${i}.html`);
      server.route(`${path}/a${i}.html`, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: page(title, lang),
      });
      return `<item><title>${title}</title><link>${link}</link><guid>${path}-${i}</guid>
<pubDate>${new Date(Date.now() - 3_600_000).toUTCString()}</pubDate>
<description>${title}: the summary from the feed.</description></item>`;
    })
    .join('\n');
  server.route(`${path}/feed.rss`, {
    status: 200,
    headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
    body: `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>${path}</title>
<link>${server.url('/')}</link><description>x</description><language>${lang}</language>${items}
</channel></rss>`,
  });
  const url = server.url(`${path}/feed.rss`);
  const result = await owner.query<{ id: string }>(
    'INSERT INTO feeds (url, fetch_url) VALUES ($1, $1) RETURNING id::text AS id',
    [url],
  );
  const feedId = result.rows[0]!.id;
  await createSubscription(owner, {
    userId: reader.id,
    feedId,
    mode: 'active',
    activatedAt: new Date(Date.now() - 60_000),
  });
  await owner.query('SELECT refresh_feed_subscribers($1::bigint[], $2::jsonb)', [
    [feedId],
    JSON.stringify({ beta: 900, admin: 300 }),
  ]);
  return feedId;
}

/** Deliver every pending intent of `queue` through `handlers`. */
async function run(handlers: HandlerMap, queue: QueueName): Promise<number> {
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

async function articlesOf(feedId: string) {
  const result = await owner.query<{ id: string; pipeline_state: string }>(
    `SELECT a.id::text AS id, a.pipeline_state FROM feed_items fi JOIN articles a ON a.id = fi.article_id
      WHERE fi.feed_id = $1 ORDER BY a.id`,
    [feedId],
  );
  return result.rows;
}

async function intentsFor(articleIds: string[]): Promise<string[]> {
  const result = await owner.query<{ queue: string }>(
    `SELECT queue FROM job_outbox
      WHERE payload->>'articleId' = ANY($1::text[]) ORDER BY id`,
    [articleIds],
  );
  return result.rows.map((r) => r.queue);
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
  workerPool = new pg.Pool({ connectionString: testDb.urls.worker, max: 6 });
  lockPool = new pg.Pool({ connectionString: testDb.urls.worker, max: 2 });
  db = createDatabase(workerPool);
  server = await startFixtureServer();
  reader = await createUser(owner);
});

afterAll(async () => {
  await server?.close();
  await Promise.all([owner?.end(), workerPool?.end(), lockPool?.end()]);
  await dropCreatedTestDatabases();
});

describe('EVAL_INGEST_ONLY (M3a-T1)', () => {
  it('narrows the consumed queues to fetching and extraction', () => {
    const all: QueueName[] = ['feed.schedule', 'feed.fetch', 'article.extract', 'article.enrich'];
    expect(effectiveWorkerQueues(all, true)).toEqual(INGEST_ONLY_QUEUES);
    expect(effectiveWorkerQueues(all, false)).toEqual(all);
  });

  it('stops after extract: an actively subscribed article gets no translate, enrich or rank intent', async () => {
    const handlers = handlersFor(true);
    const en = await addFeed('/ingest-only/en', 'en', ['Tram line approved', 'Council budget']);
    const sk = await addFeed('/ingest-only/sk', 'sk', ['Električka schválená']);
    for (const feedId of [en, sk]) {
      await dispatch(
        handlers,
        'feed.fetch',
        { feedId, force: true },
        { queue: 'feed.fetch', jobId: 'f' },
      );
    }
    expect(await run(handlers, 'article.extract')).toBe(3);
    const articles = [...(await articlesOf(en)), ...(await articlesOf(sk))];
    expect(articles.map((a) => a.pipeline_state)).toEqual(['extracted', 'extracted', 'extracted']);
    expect(await intentsFor(articles.map((a) => a.id))).toEqual([
      'article.extract',
      'article.extract',
      'article.extract',
    ]);
    const ranks = await owner.query(`SELECT 1 FROM job_outbox WHERE queue = 'user.rank'`);
    expect(ranks.rowCount).toBe(0);
  });

  it('an ordinary worker continues the same pipeline to translation and enrichment', async () => {
    const handlers = handlersFor(false);
    const en = await addFeed('/ordinary/en', 'en', ['Tram line extended']);
    const sk = await addFeed('/ordinary/sk', 'sk', ['Nová električka']);
    for (const feedId of [en, sk]) {
      await dispatch(
        handlers,
        'feed.fetch',
        { feedId, force: true },
        { queue: 'feed.fetch', jobId: 'f' },
      );
    }
    await run(handlers, 'article.extract');
    const [enArticle] = await articlesOf(en);
    const [skArticle] = await articlesOf(sk);
    expect(await intentsFor([enArticle!.id])).toContain('article.enrich');
    expect(await intentsFor([skArticle!.id])).toContain('article.translate');
  });
});

describe('golden database guard and heartbeat (M3a-T1, D-96)', () => {
  it('records the mode in worker.heartbeat, prunes stale entries and removes its own on stop', async () => {
    await owner.query(
      `INSERT INTO settings (key, value) VALUES ('worker.heartbeat', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [
        JSON.stringify({
          stale: {
            at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
            queues: [],
            evalIngestOnly: false,
            envCredentials: [],
          },
        }),
      ],
    );
    const heartbeat = await startHeartbeat({
      db,
      processId: 'host:1',
      queues: ['feed.fetch'],
      evalIngestOnly: true,
      envCredentials: ['typesafe'],
      logger: silent,
      onGoldenDatabase: () => {
        throw new Error('not expected');
      },
      intervalMs: 3_600_000,
    });
    const other = await startHeartbeat({
      db,
      processId: 'host:2',
      queues: ['article.extract'],
      evalIngestOnly: true,
      envCredentials: [],
      logger: silent,
      onGoldenDatabase: () => {},
      intervalMs: 3_600_000,
    });
    const read = async () =>
      (
        await owner.query<{ value: Record<string, { evalIngestOnly: boolean; queues: string[] }> }>(
          `SELECT value FROM settings WHERE key = 'worker.heartbeat'`,
        )
      ).rows[0]!.value;
    const value = await read();
    expect(Object.keys(value).sort()).toEqual(['host:1', 'host:2']);
    expect(value['host:1']).toMatchObject({ evalIngestOnly: true, queues: ['feed.fetch'] });
    await heartbeat.stop();
    await other.stop();
    expect(await read()).toEqual({});
  });

  it('refuses an ordinary worker on a golden database, and stops one when it turns golden', async () => {
    await expect(assertWorkerMode(db, false)).resolves.toBeUndefined();
    let violation: Error | undefined;
    const heartbeat = await startHeartbeat({
      db,
      processId: 'ordinary:1',
      queues: ['article.enrich'],
      evalIngestOnly: false,
      envCredentials: [],
      logger: silent,
      onGoldenDatabase: (error) => {
        violation = error;
      },
      intervalMs: 3_600_000,
    });
    await db.transaction(async (tx) => ensureEvalUser(tx));
    await heartbeat.beat();
    expect(violation).toBeInstanceOf(GoldenDatabaseError);
    await heartbeat.stop();
    await expect(assertWorkerMode(db, false)).rejects.toBeInstanceOf(GoldenDatabaseError);
    await expect(assertWorkerMode(db, true)).resolves.toBeUndefined();
  });

  it('rejects startHeartbeat when the database is already golden on the first beat', async () => {
    await db.transaction(async (tx) => ensureEvalUser(tx));
    let called = false;
    await expect(
      startHeartbeat({
        db,
        processId: 'ordinary:2',
        queues: ['article.enrich'],
        evalIngestOnly: false,
        envCredentials: [],
        logger: silent,
        onGoldenDatabase: () => {
          called = true;
        },
        intervalMs: 3_600_000,
      }),
    ).rejects.toBeInstanceOf(GoldenDatabaseError);
    expect(called).toBe(false);
    const entries = await owner.query<{ value: Record<string, unknown> }>(
      `SELECT value FROM settings WHERE key = 'worker.heartbeat'`,
    );
    expect(entries.rows[0]?.value?.['ordinary:2']).toBeUndefined();
  });
});
