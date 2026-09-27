import {
  MIGRATIONS_FOLDER,
  PG_BOSS_VERSION,
  claimOutboxIntents,
  completeOutboxIntent,
  createDatabase,
  createUserCard,
  createUserLabel,
  failOutboxIntent,
  runMigrations,
  withTenant,
  workerOutbox,
  type Database,
} from '@bantoozi/db';
import { createMemoryOriginLimiter } from '@bantoozi/feeds';
import { parseJobPayload, type QueueName } from '@bantoozi/shared';
import {
  FAKE_TYPESAFE_MODEL,
  createArticle,
  createFeed,
  createSubscription,
  createUser,
  dropCreatedTestDatabases,
  setupTestDatabase,
  startFakeTypeSafe,
  type FakeTypeSafeServer,
  type TestDatabase,
  type UserFixture,
} from '@bantoozi/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createWorkerCredentialResolver } from '../src/credentials/index.js';
import { createWorkerEngineRouter } from '../src/engine-router.js';
import { createWorkerDeps, pipelineContext, type WorkerDeps } from '../src/handlers/deps.js';
import { createHandlers, dispatch, type HandlerMap } from '../src/handlers/index.js';
import { after } from '../src/pipeline.js';
import { defaultSeedHooks, runSeed } from '../src/seed.js';

/**
 * M2-T11 (PLAN §7, spec 04 §10, spec 05 §11): classification end to end against a migrated and
 * seeded database, the real engine router (PostgreSQL store, spend guard, breaker, credentials) and
 * the deterministic fake TypeSafe server. An active reader holds three interest cards and a label;
 * a new arrival runs through the real handlers: enrich → cluster + match. Then two new cards
 * backfill two matched articles in one match call each, and an exhausted budget degrades the next
 * arrival without a wire attempt. `user.rank` (M5) intents are asserted, never executed.
 */

const API_KEY = 'fake-typesafe-key';
const QUIET = { info: () => {}, warn: () => {}, error: () => {} };
const SETTINGS_ENV = {
  dailyBudgetUsd: 2,
  languageModes: { en: 'native', sk: 'native', cs: 'native' },
  signupMode: 'invite',
} as const;
/** The M2 stages this test executes; everything else is kept undelivered. */
const CLASSIFICATION: readonly QueueName[] = [
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
let fake: FakeTypeSafeServer;
let deps: WorkerDeps;
let handlers: HandlerMap;
let reader: UserFixture;
let feedId: string;
const cards = { battery: '', rust: '', aviation: '', label: '' };

/** Deliver pending intents of the classification queues through the real handlers until none is left. */
async function drain(): Promise<number> {
  let ran = 0;
  for (;;) {
    const claimed = await claimOutboxIntents(db, { limit: 100, leaseSeconds: 120 });
    if (claimed.length === 0) return ran;
    let progressed = false;
    for (const intent of claimed) {
      if (!(CLASSIFICATION as readonly string[]).includes(intent.queue)) {
        await failOutboxIntent(db, intent, { error: 'e2e_kept', retryInSeconds: 86_400 });
        continue;
      }
      const queue = intent.queue as QueueName;
      const payload = parseJobPayload(queue, intent.payload);
      await dispatch(handlers, queue, payload, { queue, jobId: intent.id });
      await completeOutboxIntent(db, intent);
      ran += 1;
      progressed = true;
    }
    if (!progressed) return ran;
  }
}

/** A new extracted English arrival on the reader's feed, handed to the pipeline as extract does. */
async function arrive(title: string, excerpt: string): Promise<string> {
  const article = await createArticle(owner, { feedIds: [feedId], title, excerpt });
  await owner.query(`UPDATE articles SET pipeline_state = 'extracted', lang = 'en' WHERE id = $1`, [
    article.id,
  ]);
  await db.transaction(async (tx) => {
    await after(
      'extract',
      article.id,
      { status: 'ok', revision: article.contentRevision },
      pipelineContext(deps, tx, workerOutbox(tx)),
    );
  });
  return article.id;
}

async function pipelineState(articleId: string): Promise<string> {
  const result = await owner.query<{ pipeline_state: string }>(
    'SELECT pipeline_state FROM articles WHERE id = $1',
    [articleId],
  );
  return result.rows[0]!.pipeline_state;
}

async function cardAnswers(articleId: string): Promise<Map<string, { p: number; engine: string }>> {
  const result = await owner.query<{ card_id: string; p: number; engine: string; model: string }>(
    `SELECT card_id::text AS card_id, p, engine, model FROM card_answers WHERE article_id = $1`,
    [articleId],
  );
  for (const row of result.rows) expect(row.model).toBe(FAKE_TYPESAFE_MODEL);
  return new Map(result.rows.map((row) => [row.card_id, { p: row.p, engine: row.engine }]));
}

/** Question keys of the fake's recorded requests from `from` on. */
function requestKeys(from = 0): string[][] {
  return fake.requests.slice(from).map((request) => {
    const body = request.body as { model: string; questions: Record<string, unknown> };
    expect(body.model).toBe(FAKE_TYPESAFE_MODEL);
    expect(request.headers.authorization).toBe(`Bearer ${API_KEY}`);
    return Object.keys(body.questions).sort();
  });
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
  appPool = new pg.Pool({ connectionString: testDb.urls.app, max: 3 });
  workerPool = new pg.Pool({ connectionString: testDb.urls.worker, max: 8 });
  lockPool = new pg.Pool({ connectionString: testDb.urls.worker, max: 2 });
  db = createDatabase(workerPool);
  appDb = createDatabase(appPool);

  // The deploy seed: topics, every question set (activated) and the card library.
  await runSeed(db, SETTINGS_ENV, defaultSeedHooks());

  fake = await startFakeTypeSafe({ apiKey: API_KEY });
  const credentials = createWorkerCredentialResolver({
    db,
    masterKeyId: undefined,
    masterKeys: undefined,
    envKeys: { typesafe: API_KEY },
  });
  const router = createWorkerEngineRouter({
    db,
    config: {
      nodeEnv: 'test',
      typesafeBaseUrl: fake.url,
      typesafeModel: FAKE_TYPESAFE_MODEL,
      typesafePricePerMtokUsd: 0.5,
      engineConcurrency: 4,
      dailyBudgetUsd: SETTINGS_ENV.dailyBudgetUsd,
      ollamaBaseUrl: 'http://127.0.0.1:9',
      ollamaModelFast: 'fast',
      ollamaModelStrong: 'strong',
      ollamaMaxConcurrency: 1,
      llmFallbackEnabled: false,
    },
    credentials,
    logger: QUIET,
  });
  deps = createWorkerDeps({
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
    },
  });
  handlers = createHandlers(deps);

  reader = await createUser(owner);
  feedId = (await createFeed(owner, { title: 'Daily Wire' })).id;
  await createSubscription(owner, {
    userId: reader.id,
    feedId,
    mode: 'active',
    activatedAt: new Date(Date.now() - 86_400_000),
  });
  // The fake answers 0.9 when a card's text shares a word with the article's title or excerpt,
  // 0.2 when only its not_for does, else 0.1 (spec 04 §10).
  await withTenant(appDb, reader.id, async (tx) => {
    const battery = await createUserCard(tx, {
      title: 'EV batteries',
      interest: 'Solid-state battery chemistry for electric vehicles',
      strength: 'love',
      lang: 'en',
    });
    const rust = await createUserCard(tx, {
      title: 'Rust',
      interest: 'The Rust programming language: releases, libraries and tooling',
      strength: 'like',
      lang: 'en',
    });
    const aviation = await createUserCard(tx, {
      title: 'Aviation',
      interest: 'Commercial aviation and the airline business',
      notFor: 'Pilot schools and flight training',
      strength: 'like',
      lang: 'en',
    });
    const label = await createUserLabel(tx, {
      name: 'Battery tech',
      definition: 'Articles on batteries and storage cells',
      lang: 'en',
    });
    cards.battery = battery.card.id;
    cards.rust = rust.card.id;
    cards.aviation = aviation.card.id;
    cards.label = label.label.id;
  });
  // The cards' backfills find nothing yet: no article has arrived.
  await drain();
  expect(fake.requestCount()).toBe(0);
}, 120_000);

afterAll(async () => {
  await fake?.close();
  await Promise.all([owner?.end(), appPool?.end(), workerPool?.end(), lockPool?.end()]);
  await dropCreatedTestDatabases();
});

describe('classification end to end (M2-T11)', () => {
  let battery = '';

  it('classifies a new arrival: facets, card and label answers, level-2 topics, matched', async () => {
    battery = await arrive(
      'Solid-state batteries reach the pilot line for electric cars',
      'Three manufacturers start pilot production of solid-state cells for electric cars.',
    );
    await drain();

    // One enrich call, then one match pack with the three cards, the label and the L2 branch; the
    // cluster stage finds no similar article and makes no call.
    const keys = requestKeys();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toEqual(
      [
        'clickbait',
        'content_type',
        'depth',
        'evergreen',
        'local_scope',
        'paywall_teaser',
        'promotional',
        'time_sensitive',
        'tone',
        'topic_l1',
      ].sort(),
    );
    expect(keys[1]).toEqual(
      [
        `c${cards.battery}`,
        `c${cards.rust}`,
        `c${cards.aviation}`,
        `c${cards.label}`,
        't2_transport',
      ].sort(),
    );

    const facets = await owner.query<{
      engine: string;
      model: string;
      state_variant: string;
      features: Record<string, number>;
    }>(
      `SELECT af.engine, af.model, af.state_variant, af.features
         FROM article_facets af
        WHERE af.article_id = $1
          AND af.question_set_id = ((SELECT value->>'enrich' FROM settings
                                      WHERE key = 'question_sets.active'))::bigint`,
      [battery],
    );
    expect(facets.rows).toHaveLength(1);
    const facet = facets.rows[0]!;
    expect(facet).toMatchObject({
      engine: 'typesafe',
      model: FAKE_TYPESAFE_MODEL,
      state_variant: 'native',
    });
    expect(facet.features['t1.transport']).toBeCloseTo(0.7, 5);
    expect(facet.features['t2_asked.transport']).toBe(1);
    expect(facet.features['t2.transport.cars']).toBeCloseTo(0.49, 5);

    const answers = await cardAnswers(battery);
    expect(answers.size).toBe(4);
    expect(answers.get(cards.battery)?.p).toBeCloseTo(0.9, 5);
    expect(answers.get(cards.rust)?.p).toBeCloseTo(0.1, 5);
    expect(answers.get(cards.aviation)?.p).toBeCloseTo(0.2, 5);
    expect(answers.get(cards.label)?.p).toBeCloseTo(0.9, 5);
    for (const answer of answers.values()) expect(answer.engine).toBe('typesafe');

    const l2 = await owner.query<{ l1_id: string; engine: string }>(
      'SELECT l1_id, engine FROM article_topics_l2 WHERE article_id = $1',
      [battery],
    );
    expect(l2.rows).toEqual([{ l1_id: 'transport', engine: 'typesafe' }]);
    expect(await pipelineState(battery)).toBe('matched');

    // One engine_calls row per wire attempt, priced and attributed; the reader's rank is recorded.
    const calls = await owner.query<{
      kind: string;
      status: string;
      cost: string;
      user_id: string | null;
    }>(
      `SELECT kind, status, cost_usd::text AS cost, user_id::text AS user_id
         FROM engine_calls WHERE article_id = $1 ORDER BY id`,
      [battery],
    );
    expect(calls.rows.map((row) => [row.kind, row.status])).toEqual([
      ['enrich', 'ok'],
      ['match', 'ok'],
    ]);
    for (const row of calls.rows) expect(Number(row.cost)).toBeGreaterThan(0);
    const usage = await owner.query<{ calls: number }>(
      `SELECT coalesce(sum(calls), 0)::int AS calls FROM usage_daily WHERE engine = 'typesafe'`,
    );
    expect(usage.rows[0]!.calls).toBe(2);
    const ranks = await owner.query<{ payload: { userId: string; reason: string } }>(
      `SELECT payload FROM job_outbox WHERE queue = 'user.rank' AND payload->>'reason' = 'match'`,
    );
    expect(ranks.rows.map((row) => row.payload.userId)).toContain(reader.id);
  });

  it('backfills two matched articles for two new cards in one match call each', async () => {
    const trains = await arrive(
      'Night trains return to the Vienna timetable',
      'Sleeper services to Hamburg and Rome restart in December.',
    );
    await drain();
    expect(await pipelineState(trains)).toBe('matched');

    const before = fake.requestCount();
    const added: string[] = [];
    await withTenant(appDb, reader.id, async (tx) => {
      for (const interest of [
        'Sleeper trains and night rail timetables in Europe',
        'Sodium-ion cells as a cheaper battery chemistry',
      ]) {
        added.push((await createUserCard(tx, { interest, strength: 'like', lang: 'en' })).card.id);
      }
    });
    await drain();

    // Both backfills queue their pairs before the article jobs run, and each article's match job
    // drains every queued card in one pack: two calls for two cards on two articles.
    const keys = requestKeys(before);
    expect(fake.requestCount() - before).toBeLessThanOrEqual(2);
    expect(keys).toEqual([added.map((id) => `c${id}`).sort(), added.map((id) => `c${id}`).sort()]);
    for (const articleId of [battery, trains]) {
      const answers = await cardAnswers(articleId);
      for (const id of added) expect(answers.has(id)).toBe(true);
      expect(await pipelineState(articleId)).toBe('matched');
    }
    const pending = await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM match_queue');
    expect(pending.rows[0]!.n).toBe(0);
  });

  it('degrades a new arrival without a wire attempt when the budget is exhausted', async () => {
    await owner.query(
      `INSERT INTO settings (key, value) VALUES ('engine.daily_budget_usd', '0'::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    const before = fake.requestCount();
    const rankedBefore = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM job_outbox WHERE queue = 'user.rank' AND payload->>'reason' = 'degraded'`,
    );

    const article = await arrive(
      'Harbour cranes switch to shore power',
      'Container terminals replace diesel generators at the quay.',
    );
    await drain();

    expect(fake.requestCount()).toBe(before);
    expect(await pipelineState(article)).toBe('degraded');
    const facets = await owner.query('SELECT 1 FROM article_facets WHERE article_id = $1', [
      article,
    ]);
    expect(facets.rowCount).toBe(0);
    const ranked = await owner.query<{ payload: { userId: string } }>(
      `SELECT payload FROM job_outbox WHERE queue = 'user.rank' AND payload->>'reason' = 'degraded'`,
    );
    expect(ranked.rows.length).toBeGreaterThan(rankedBefore.rows[0]!.n);
    expect(ranked.rows.map((row) => row.payload.userId)).toContain(reader.id);
  });
});
