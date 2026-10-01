import {
  MIGRATIONS_FOLDER,
  PG_BOSS_VERSION,
  claimOutboxIntents,
  completeOutboxIntent,
  createDatabase,
  createUserCard,
  failOutboxIntent,
  recordRankIntents,
  runMigrations,
  withTenant,
  workerOutbox,
  type Database,
} from '@bantoozi/db';
import { createMemoryOriginLimiter } from '@bantoozi/feeds';
import { parseJobPayload, type Explain, type QueueName } from '@bantoozi/shared';
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
 * M5-T6 (PLAN §11, spec 06): ranking end to end against a migrated and seeded database, the real
 * engine router and the deterministic fake TypeSafe server. Two active readers of the same feed hold
 * different cards; each arrival runs through the real handlers, extract → enrich → cluster + match →
 * `user.rank`, and the lanes land in `user_article`. One reader's never-card and mute hide what they
 * cover; with the budget spent, a degraded arrival is ranked by BM25 into Maybe.
 */

const API_KEY = 'fake-typesafe-key';
const QUIET = { info: () => {}, warn: () => {}, error: () => {} };
const SETTINGS_ENV = {
  dailyBudgetUsd: 2,
  languageModes: { en: 'native', sk: 'native', cs: 'native' },
  signupMode: 'invite',
} as const;
/** The stages this test executes; everything else is kept undelivered. */
const STAGES: readonly QueueName[] = [
  'article.enrich',
  'article.cluster',
  'article.match',
  'card.backfill',
  'user.rank',
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
let feedId: string;
const users = { ana: '', ben: '' };

/** Deliver pending intents of the executed stages through the real handlers until none is left. */
async function drain(): Promise<void> {
  for (;;) {
    const claimed = await claimOutboxIntents(db, { limit: 100, leaseSeconds: 120 });
    if (claimed.length === 0) return;
    let progressed = false;
    for (const intent of claimed) {
      if (!(STAGES as readonly string[]).includes(intent.queue)) {
        await failOutboxIntent(db, intent, { error: 'e2e_kept', retryInSeconds: 86_400 });
        continue;
      }
      const queue = intent.queue as QueueName;
      await dispatch(handlers, queue, parseJobPayload(queue, intent.payload), {
        queue,
        jobId: intent.id,
      });
      await completeOutboxIntent(db, intent);
      progressed = true;
    }
    if (!progressed) return;
  }
}

/** A new extracted English arrival on the shared feed, handed to the pipeline as extract does. */
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
  await drain();
  return article.id;
}

interface Ranked {
  lane: string;
  source: string;
  rules: string[];
  explain: Explain | null;
}

async function ranked(userId: string, articleId: string): Promise<Ranked | undefined> {
  const result = await owner.query<{
    lane: string;
    score_source: string;
    rules_fired: string[];
    explain: Explain | null;
    scored_at: Date | null;
  }>(
    `SELECT lane, score_source, rules_fired, explain, scored_at FROM user_article
      WHERE user_id = $1 AND article_id = $2`,
    [userId, articleId],
  );
  const row = result.rows[0];
  if (row === undefined || row.scored_at === null) return undefined;
  return { lane: row.lane, source: row.score_source, rules: row.rules_fired, explain: row.explain };
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

  feedId = (await createFeed(owner, { title: 'Daily Wire' })).id;
  users.ana = (await createUser(owner)).id;
  users.ben = (await createUser(owner)).id;
  for (const userId of [users.ana, users.ben]) {
    await createSubscription(owner, {
      userId,
      feedId,
      mode: 'active',
      activatedAt: new Date(Date.now() - 86_400_000),
    });
  }
  // The fake answers 0.9 when a card's text shares a word with the article's title or excerpt,
  // 0.2 when only its not_for does, else 0.1 (spec 04 §10).
  await withTenant(appDb, users.ana, async (tx) => {
    await createUserCard(tx, {
      interest: 'Solid-state battery chemistry for electric vehicles',
      strength: 'love',
      lang: 'en',
    });
    await createUserCard(tx, {
      interest: 'Harbour cranes, container terminals and port logistics',
      strength: 'like',
      lang: 'en',
    });
  });
  await withTenant(appDb, users.ben, async (tx) => {
    await createUserCard(tx, {
      interest: 'Sleeper trains and night rail timetables in Europe',
      strength: 'love',
      lang: 'en',
    });
    await createUserCard(tx, {
      interest: 'Batteries and battery makers',
      strength: 'never',
      lang: 'en',
    });
  });
  // Ana mutes rail news (spec 06 §3.1); the rule's full rank runs with the first drain.
  await owner.query(
    `INSERT INTO user_rules (user_id, kind, value) VALUES ($1, 'mute_keyword', 'sleeper')`,
    [users.ana],
  );
  await db.transaction((tx) =>
    recordRankIntents(tx, workerOutbox(tx), [users.ana], { reason: 'rule', full: true }),
  );
  await drain();
}, 120_000);

afterAll(async () => {
  await fake?.close();
  await Promise.all([owner?.end(), appPool?.end(), workerPool?.end(), lockPool?.end()]);
  await dropCreatedTestDatabases();
});

describe('ranking end to end (M5-T6)', () => {
  it('ranks one arrival differently for two readers: Ana gets it For you, Ben`s never-card hides it', async () => {
    const battery = await arrive(
      'Solid-state batteries reach the pilot line for electric cars',
      'Three manufacturers start pilot production of solid-state battery cells for electric cars.',
    );
    const ana = await ranked(users.ana, battery);
    expect(ana).toMatchObject({ lane: 'for_you', source: 'cards' });
    expect(ana?.explain?.cards[0]).toMatchObject({ strength: 'love', engine: 'typesafe' });

    const ben = await ranked(users.ben, battery);
    expect(ben?.lane).toBe('hidden');
    expect(ben?.rules.some((code) => code.startsWith('never:'))).toBe(true);
  });

  it('ranks a rail arrival For you for Ben, while Ana`s mute hides it', async () => {
    const trains = await arrive(
      'Sleeper trains return to the Vienna timetable',
      'Night rail services to Hamburg and Rome restart in December.',
    );
    expect(await ranked(users.ben, trains)).toMatchObject({ lane: 'for_you', source: 'cards' });
    const ana = await ranked(users.ana, trains);
    expect(ana).toMatchObject({ lane: 'hidden', rules: ['mute_keyword:sleeper'] });
    expect(ana?.explain?.rules[0]?.ruleId).toBeDefined();
  });

  it('ranks a degraded arrival by BM25 into Maybe', async () => {
    await owner.query(
      `INSERT INTO settings (key, value) VALUES ('engine.daily_budget_usd', '0'::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    const before = fake.requestCount();
    const cranes = await arrive(
      'Harbour cranes at container terminals switch to shore power',
      'Port logistics: container terminals replace diesel generators for their harbour cranes.',
    );
    expect(fake.requestCount()).toBe(before);
    const state = await owner.query<{ pipeline_state: string }>(
      'SELECT pipeline_state FROM articles WHERE id = $1',
      [cranes],
    );
    expect(state.rows[0]?.pipeline_state).toBe('degraded');
    expect(await ranked(users.ana, cranes)).toMatchObject({ lane: 'maybe', source: 'degraded' });
  });
});
