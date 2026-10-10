import { randomUUID } from 'node:crypto';

import {
  MIGRATIONS_FOLDER,
  PG_BOSS_VERSION,
  claimOutboxIntents,
  completeOutboxIntent,
  createDatabase,
  failOutboxIntent,
  runMigrations,
  workerOutbox,
  type Database,
} from '@bantoozi/db';
import type { EngineOutcome, EngineRequest, EngineRouter } from '@bantoozi/engine';
import { createMemoryOriginLimiter } from '@bantoozi/feeds';
import { parseJobPayload, type QueueName } from '@bantoozi/shared';
import {
  FAKE_TYPESAFE_MODEL,
  createArticle,
  createCard,
  createFeed,
  createSubscription,
  createUser,
  dropCreatedTestDatabases,
  setupTestDatabase,
  startFakeOllama,
  startFakeTypeSafe,
  type FakeOllamaServer,
  type FakeTypeSafeServer,
  type TestDatabase,
} from '@bantoozi/testing';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createWorkerCredentialResolver } from '../src/credentials/index.js';
import { createWorkerEngineRouter, type WorkerEngineConfig } from '../src/engine-router.js';
import { createWorkerDeps, pipelineContext, type WorkerDeps } from '../src/handlers/deps.js';
import { createHandlers, dispatch, type HandlerMap } from '../src/handlers/index.js';
import { after } from '../src/pipeline.js';
import { defaultSeedHooks, runSeed } from '../src/seed.js';

/**
 * M7-T6 `user.suggest {userId}` (spec 05 §7, PLAN §13 T6) through the real handler, the real engine
 * router (PostgreSQL store, spend guard, breaker, credentials) and the deterministic fake TypeSafe
 * server. The handler is imported lazily, so an unimplemented handler fails each test (not the
 * file's setup), and the fixtures can be proven on their own.
 *
 * Fixture model: one classified feed. A seed reader (who holds the shared positive card P) makes
 * the pipeline enrich and match five "Zorblax cars" articles; the fake answers `transport` for
 * the topic and 0.1 for P, so each one is an unexplained like of the `transport` branch. Every
 * test user subscribes actively to the feed, holds P and rates articles +1 as that test needs. The
 * public library card L (topic `transport`, interest "Zorblax electric vehicles") shares a token
 * with the articles, so the fake gives it probability 0.7 against `none`.
 */

const API_KEY = 'fake-typesafe-key';
const OLLAMA_KEY = 'fake-ollama-key';
const QUIET = { info: () => {}, warn: () => {}, error: () => {} };
const DAY = 86_400_000;
const BUDGET_USD = 2;
const SETTINGS_ENV = {
  dailyBudgetUsd: BUDGET_USD,
  languageModes: { en: 'native', sk: 'native', cs: 'native' },
  signupMode: 'invite',
} as const;
const CLASSIFICATION: readonly QueueName[] = [
  'article.enrich',
  'article.cluster',
  'article.match',
  'card.backfill',
];
const PIN = { model: FAKE_TYPESAFE_MODEL };

let testDb: TestDatabase;
let owner: pg.Pool;
let workerPool: pg.Pool;
let lockPool: pg.Pool;
let db: Database;
let fake: FakeTypeSafeServer;
let fakeOllama: FakeOllamaServer;
let deps: WorkerDeps;
let engineConfig: WorkerEngineConfig;
let handlers: HandlerMap;
let feedId: string;
let activeSet: string;
/** The shared positive card every test user holds; it explains none of the articles. */
let heldCardId: string;
/** The public library card of the `transport` branch the articles point to. */
let libraryCardId: string;
/** A public library card elsewhere (topic `health`), used as "another card" in seeded rows. */
let otherCardId: string;
const articleIds: string[] = [];

/** The router seam of the suggest handler: tests may wrap it to interleave with `ask`. */
let routerWrap: ((inner: EngineRouter) => EngineRouter) | null = null;

async function drain(): Promise<void> {
  for (;;) {
    const claimed = await claimOutboxIntents(db, { limit: 100, leaseSeconds: 120 });
    if (claimed.length === 0) return;
    let progressed = false;
    for (const intent of claimed) {
      if (!(CLASSIFICATION as readonly string[]).includes(intent.queue)) {
        await failOutboxIntent(db, intent, { error: 'suggest_kept', retryInSeconds: 86_400 });
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

function realRouter(
  config: WorkerEngineConfig,
  credentialKeys: { typesafe: string; ollama?: string },
): EngineRouter {
  return createWorkerEngineRouter({
    db,
    config,
    credentials: createWorkerCredentialResolver({
      db,
      masterKeyId: undefined,
      masterKeys: undefined,
      envKeys: credentialKeys,
    }),
    logger: QUIET,
  });
}

function depsWith(router: EngineRouter): WorkerDeps {
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
}

async function setSetting(key: string, value: unknown): Promise<void> {
  await owner.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)],
  );
}

async function questionSet(version: string): Promise<string> {
  const result = await owner.query<{ id: string }>(
    `INSERT INTO question_sets (kind, version, sha256, definition)
     VALUES ('suggest', $1, $2, '{}'::jsonb) RETURNING id::text AS id`,
    [version, randomUUID().replaceAll('-', '').padEnd(64, '0')],
  );
  return result.rows[0]!.id;
}

/** Run the real handler once for the user, with the current `deps` (or `with`). */
async function runSuggest(userId: string, using: WorkerDeps = deps): Promise<void> {
  const { createUserSuggestHandler } = await import('../src/handlers/user-suggest.js');
  const handler = createUserSuggestHandler(
    routerWrap === null
      ? using
      : {
          ...using,
          classification: {
            ...using.classification!,
            router: routerWrap(using.classification!.router),
          },
        },
  );
  await handler({ userId }, { queue: 'user.suggest', jobId: randomUUID() } as never);
}

/** A reader: active feed subscription since long ago, the held card, and likes on the first `likes` articles. */
async function reader(options: { likes?: number; likedAgo?: number } = {}): Promise<string> {
  const user = await createUser(owner);
  await createSubscription(owner, {
    userId: user.id,
    feedId,
    mode: 'active',
    activatedAt: new Date(Date.now() - 10 * DAY),
  });
  await owner.query(
    `INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, 'like')`,
    [user.id, heldCardId],
  );
  await like(user.id, options.likes ?? 4, options.likedAgo ?? 1 * DAY);
  return user.id;
}

/** Rate the first `count` articles +1 at `ago` ms ago. */
async function like(userId: string, count: number, ago: number, from = 0): Promise<void> {
  for (const articleId of articleIds.slice(from, from + count)) {
    await owner.query(
      `INSERT INTO user_article (user_id, article_id, rating, rated_at)
       VALUES ($1, $2, 1, now() - $3::double precision * interval '1 millisecond')
       ON CONFLICT (user_id, article_id) DO UPDATE SET rating = 1, rated_at = EXCLUDED.rated_at`,
      [userId, articleId, ago],
    );
  }
}

interface SuggestionRow {
  card_id: string;
  score: number;
  question_set_id: string;
  model_pin: string;
  dismissed_at: Date | null;
  created_at: Date;
}

async function suggestions(userId: string): Promise<SuggestionRow[]> {
  const result = await owner.query<SuggestionRow>(
    `SELECT card_id::text AS card_id, score, question_set_id::text AS question_set_id, model_pin,
            dismissed_at, created_at
       FROM card_suggestions WHERE user_id = $1 ORDER BY card_id`,
    [userId],
  );
  return result.rows;
}

interface UserState {
  last_suggested_at: Date | null;
  suggest_lease_token: string | null;
  suggest_lease_until: Date | null;
}

async function userState(userId: string): Promise<UserState> {
  const result = await owner.query<UserState>(
    `SELECT last_suggested_at, suggest_lease_token, suggest_lease_until FROM users WHERE id = $1`,
    [userId],
  );
  return result.rows[0]!;
}

async function reservations(userId: string): Promise<number> {
  const result = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM engine_reservations WHERE user_id = $1`,
    [userId],
  );
  return result.rows[0]!.n;
}

async function engineCalls(userId: string): Promise<number> {
  const result = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM engine_calls WHERE user_id = $1 AND kind = 'suggest'`,
    [userId],
  );
  return result.rows[0]!.n;
}

/** Seed a suggestion row; `dismissedAgo` null leaves it undismissed. */
async function seedSuggestion(
  userId: string,
  cardId: string,
  options: { dismissedAgo?: number | null; set?: string; pin?: string; score?: number } = {},
): Promise<void> {
  await owner.query(
    `INSERT INTO card_suggestions (user_id, card_id, question_set_id, model_pin, score, dismissed_at)
     VALUES ($1, $2, $3, $4, $5,
             CASE WHEN $6::double precision IS NULL THEN NULL
                  ELSE now() - $6::double precision * interval '1 millisecond' END)`,
    [
      userId,
      cardId,
      options.set ?? activeSet,
      options.pin ?? FAKE_TYPESAFE_MODEL,
      options.score ?? 0.5,
      options.dismissedAgo ?? null,
    ],
  );
}

/** Question keys of the fake TypeSafe requests from `from` on. */
function askedKeys(from: number): string[][] {
  return fake.requests
    .slice(from)
    .map((request) =>
      Object.values(
        (request.body as { questions: Record<string, { criteria?: Record<string, unknown> }> })
          .questions,
      )
        .flatMap((question) => Object.keys(question.criteria ?? {}))
        .sort(),
    );
}

const publicCard = (interest: string, topicIds: string[]) =>
  createCard(owner, {
    visibility: 'public',
    origin: 'library',
    title: interest,
    interest,
    topicIds,
    slug: `suggest-${randomUUID()}`,
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
  workerPool = new pg.Pool({ connectionString: testDb.urls.worker, max: 8 });
  lockPool = new pg.Pool({ connectionString: testDb.urls.worker, max: 2 });
  db = createDatabase(workerPool);

  await runSeed(db, SETTINGS_ENV, defaultSeedHooks());
  // The suggestion tests control the library themselves: the seeded cards must not compete.
  await owner.query(`UPDATE interest_cards SET retired_at = now() WHERE origin = 'library'`);
  const active = await owner.query<{ value: { suggest?: string } }>(
    `SELECT value FROM settings WHERE key = 'question_sets.active'`,
  );
  activeSet = String(active.rows[0]!.value.suggest);
  await setSetting('engine.model_pin', PIN);

  fake = await startFakeTypeSafe({ apiKey: API_KEY });
  fakeOllama = await startFakeOllama({ apiKey: OLLAMA_KEY });
  engineConfig = {
    nodeEnv: 'test',
    typesafeBaseUrl: fake.url,
    typesafeModel: FAKE_TYPESAFE_MODEL,
    typesafePricePerMtokUsd: 0.5,
    engineConcurrency: 4,
    dailyBudgetUsd: BUDGET_USD,
    ollamaBaseUrl: fakeOllama.url,
    ollamaModelFast: 'fast',
    ollamaModelStrong: 'strong',
    ollamaMaxConcurrency: 1,
    llmFallbackEnabled: false,
  };
  deps = depsWith(realRouter(engineConfig, { typesafe: API_KEY }));
  handlers = createHandlers(deps);

  // Classification: a seed reader holding the shared card P makes the pipeline enrich and match
  // five Zorblax articles (topic `transport`, P answered 0.1).
  feedId = (await createFeed(owner, { title: 'Zorblax Daily' })).id;
  const held = await createCard(owner, {
    visibility: 'shared',
    title: 'Quilting',
    interest: 'Quilting patterns and fabric hobby crafts',
    topicIds: ['health'],
  });
  heldCardId = held.id;
  const seedReader = await createUser(owner);
  await createSubscription(owner, {
    userId: seedReader.id,
    feedId,
    mode: 'active',
    activatedAt: new Date(Date.now() - 10 * DAY),
  });
  await owner.query(
    `INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, 'like')`,
    [seedReader.id, heldCardId],
  );
  for (let i = 1; i <= 5; i += 1) {
    const article = await createArticle(owner, {
      feedIds: [feedId],
      title: `Zorblax cars story ${i}`,
      excerpt: `Zorblax cars report number ${i} on vehicles.`,
      firstSeenAt: new Date(Date.now() - 5 * DAY + i * 60_000),
    });
    await owner.query(
      `UPDATE articles SET pipeline_state = 'extracted', lang = 'en' WHERE id = $1`,
      [article.id],
    );
    await db.transaction(async (tx) => {
      await after(
        'extract',
        article.id,
        { status: 'ok', revision: article.contentRevision },
        pipelineContext(deps, tx, workerOutbox(tx)),
      );
    });
    articleIds.push(article.id);
  }
  await drain();

  libraryCardId = (await publicCard('Zorblax electric vehicles', ['transport'])).id;
  otherCardId = (await publicCard('Pottery and ceramics studio techniques', ['health'])).id;
}, 180_000);

afterAll(async () => {
  await Promise.all([fake?.close(), fakeOllama?.close()]);
  await Promise.all([owner?.end(), workerPool?.end(), lockPool?.end()]);
  await dropCreatedTestDatabases();
});

beforeEach(async () => {
  routerWrap = null;
  await setSetting('engine.model_pin', PIN);
  await setSetting('engine.daily_budget_usd', BUDGET_USD);
});

describe('user.suggest (M7-T6, spec 05 §7)', () => {
  it('end-to-end: a user with an active feed, >=3 unexplained liked articles whose titles share a token with one library card -> one fake-engine call; the card is suggested, last_suggested_at stamped, lease cleared', async () => {
    const userId = await reader({ likes: 4 });
    const from = fake.requestCount();
    await runSuggest(userId);

    expect(fake.requestCount() - from).toBe(1);
    expect(askedKeys(from)).toEqual([[`c${libraryCardId}`, 'none'].sort()]);
    const rows = await suggestions(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      card_id: libraryCardId,
      question_set_id: activeSet,
      model_pin: 'jev-fake',
      dismissed_at: null,
    });
    expect(rows[0]!.score).toBeGreaterThanOrEqual(0.15);
    expect(rows[0]!.score).toBeCloseTo(0.7, 5);
    const state = await userState(userId);
    expect(state.last_suggested_at).not.toBeNull();
    expect(Date.now() - state.last_suggested_at!.getTime()).toBeLessThan(60_000);
    expect(state.suggest_lease_token).toBeNull();
    expect(state.suggest_lease_until).toBeNull();
    expect(await reservations(userId)).toBe(1);
    expect(await engineCalls(userId)).toBe(1);
  });

  it('a card dismissed 20 days ago is not suggested again, also after the active suggest set id or the model pin changed', async () => {
    // A second matching card, so that the exclusion shows in what is offered: the dismissed card
    // (lower id) would win the fake's 0.7 if it were offered.
    const second = await publicCard('Zorblax solar vehicles', ['transport']);
    try {
      for (const variant of ['same', 'set', 'pin'] as const) {
        const userId = await reader({ likes: 4 });
        const oldSet = variant === 'set' ? await questionSet(`suggest-old-${randomUUID()}`) : activeSet;
        const oldPin = variant === 'pin' ? 'jev-old' : FAKE_TYPESAFE_MODEL;
        await seedSuggestion(userId, libraryCardId, {
          dismissedAgo: 20 * DAY,
          set: oldSet,
          pin: oldPin,
        });
        const before = (await suggestions(userId))[0]!;
        if (variant === 'set') {
          // The dismissed row belongs to a set that is no longer active.
          expect(oldSet).not.toBe(activeSet);
        }
        const from = fake.requestCount();
        await runSuggest(userId);

        expect(askedKeys(from), variant).toEqual([[`c${second.id}`, 'none'].sort()]);
        const rows = await suggestions(userId);
        const kept = rows.find((r) => r.card_id === libraryCardId)!;
        expect(kept.dismissed_at?.getTime(), variant).toBe(before.dismissed_at!.getTime());
        expect(kept.question_set_id, variant).toBe(oldSet);
        expect(kept.model_pin, variant).toBe(oldPin);
        expect(kept.score, variant).toBeCloseTo(before.score, 5);
        const added = rows.find((r) => r.card_id === second.id);
        expect(added?.dismissed_at, variant).toBeNull();
        await setSetting('engine.model_pin', PIN);
      }
    } finally {
      await owner.query(`UPDATE interest_cards SET retired_at = now() WHERE id = $1`, [second.id]);
    }
  });

  it('a card dismissed 100 days ago can be suggested again, and the upsert clears its dismissed_at', async () => {
    const userId = await reader({ likes: 4 });
    await seedSuggestion(userId, libraryCardId, { dismissedAgo: 100 * DAY, score: 0.2 });
    const from = fake.requestCount();
    await runSuggest(userId);

    expect(askedKeys(from)).toEqual([[`c${libraryCardId}`, 'none'].sort()]);
    const rows = await suggestions(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      card_id: libraryCardId,
      dismissed_at: null,
      question_set_id: activeSet,
      model_pin: 'jev-fake',
    });
    expect(rows[0]!.score).toBeCloseTo(0.7, 5);
  });

  it('a later run replaces earlier undismissed suggestions', async () => {
    const userId = await reader({ likes: 4 });
    await seedSuggestion(userId, otherCardId, { score: 0.6 });
    await runSuggest(userId);

    const rows = await suggestions(userId);
    expect(rows.map((r) => r.card_id)).toEqual([libraryCardId]);
    expect(rows[0]!.dismissed_at).toBeNull();
  });

  it('a run whose evidence expired (likes older than 30 days) sends nothing and deletes undismissed rows, keeps dismissed ones', async () => {
    const userId = await reader({ likes: 4, likedAgo: 40 * DAY });
    await seedSuggestion(userId, otherCardId, { score: 0.6 });
    await seedSuggestion(userId, libraryCardId, { dismissedAgo: 20 * DAY });
    const from = fake.requestCount();
    await runSuggest(userId);

    expect(fake.requestCount()).toBe(from);
    expect(await reservations(userId)).toBe(0);
    const rows = await suggestions(userId);
    expect(rows.map((r) => [r.card_id, r.dismissed_at === null])).toEqual([[libraryCardId, false]]);
    const state = await userState(userId);
    expect(state.last_suggested_at).toBeNull();
    expect(state.suggest_lease_token).toBeNull();
  });

  it('an off-only user (no active subscription, no selection) sends nothing and deletes undismissed rows', async () => {
    const userId = await reader({ likes: 4 });
    await owner.query(
      `UPDATE subscriptions SET inference_mode = 'off', inference_activated_at = NULL,
              inference_version = inference_version + 1
        WHERE user_id = $1`,
      [userId],
    );
    await seedSuggestion(userId, otherCardId, { score: 0.6 });
    await seedSuggestion(userId, libraryCardId, { dismissedAgo: 20 * DAY });
    const from = fake.requestCount();
    await runSuggest(userId);

    expect(fake.requestCount()).toBe(from);
    expect(await reservations(userId)).toBe(0);
    const rows = await suggestions(userId);
    expect(rows.map((r) => [r.card_id, r.dismissed_at === null])).toEqual([[libraryCardId, false]]);
    const state = await userState(userId);
    expect(state.last_suggested_at).toBeNull();
    expect(state.suggest_lease_token).toBeNull();
  });

  it('at most one admitted attempt per day: a second run within 24 h sends nothing (no new engine call / reservation)', async () => {
    const userId = await reader({ likes: 4 });
    await runSuggest(userId);
    const stamped = (await userState(userId)).last_suggested_at;
    expect(stamped).not.toBeNull();
    expect(await reservations(userId)).toBe(1);
    const from = fake.requestCount();
    // Evidence changed meanwhile: only the 24 h gate stops the second run.
    await seedSuggestion(userId, otherCardId, { score: 0.4 });
    await runSuggest(userId);

    expect(fake.requestCount()).toBe(from);
    expect(await reservations(userId)).toBe(1);
    expect(await engineCalls(userId)).toBe(1);
    expect((await userState(userId)).last_suggested_at?.getTime()).toBe(stamped!.getTime());
    expect((await userState(userId)).suggest_lease_token).toBeNull();
    expect((await suggestions(userId)).map((r) => r.card_id).sort()).toEqual(
      [libraryCardId, otherCardId].sort(),
    );

    // The gate opens again after 24 h.
    await owner.query(
      `UPDATE users SET last_suggested_at = now() - interval '25 hours' WHERE id = $1`,
      [userId],
    );
    await runSuggest(userId);
    expect(fake.requestCount()).toBe(from + 1);
    expect(await reservations(userId)).toBe(2);
  });

  it('a run that sends nothing (too few likes) does not stamp last_suggested_at, and a later run with enough likes does send', async () => {
    const userId = await reader({ likes: 2 });
    const from = fake.requestCount();
    await runSuggest(userId);

    expect(fake.requestCount()).toBe(from);
    expect(await reservations(userId)).toBe(0);
    let state = await userState(userId);
    expect(state.last_suggested_at).toBeNull();
    expect(state.suggest_lease_token).toBeNull();
    expect(state.suggest_lease_until).toBeNull();

    await like(userId, 2, 1 * DAY, 2);
    await runSuggest(userId);
    expect(fake.requestCount()).toBe(from + 1);
    state = await userState(userId);
    expect(state.last_suggested_at).not.toBeNull();
    expect((await suggestions(userId)).map((r) => r.card_id)).toEqual([libraryCardId]);
  });

  it('budget deferral (daily budget 0 or cap reached) sends nothing and does not stamp; earlier undismissed rows remain', async () => {
    const userId = await reader({ likes: 4 });
    await seedSuggestion(userId, otherCardId, { score: 0.6 });
    await setSetting('engine.daily_budget_usd', 0);
    const from = fake.requestCount();
    await runSuggest(userId);

    expect(fake.requestCount()).toBe(from);
    expect(await reservations(userId)).toBe(0);
    expect(await engineCalls(userId)).toBe(0);
    const state = await userState(userId);
    expect(state.last_suggested_at).toBeNull();
    expect(state.suggest_lease_token).toBeNull();
    expect(state.suggest_lease_until).toBeNull();
    expect((await suggestions(userId)).map((r) => r.card_id)).toEqual([otherCardId]);

    // With budget back, the next trigger is not blocked by the deferral.
    await setSetting('engine.daily_budget_usd', BUDGET_USD);
    await runSuggest(userId);
    expect(fake.requestCount()).toBe(from + 1);
    expect((await suggestions(userId)).map((r) => r.card_id)).toEqual([libraryCardId]);
  });

  it('lease lost before the reservation: no engine_reservations row, no fake-engine request, last_suggested_at unchanged, card_suggestions unchanged', async () => {
    const userId = await reader({ likes: 4 });
    await seedSuggestion(userId, otherCardId, { score: 0.6 });
    const before = await suggestions(userId);
    const stolenToken = randomUUID();
    let asked = 0;
    routerWrap = (inner) => ({
      ...inner,
      ask: async (req: EngineRequest, signal?: AbortSignal): Promise<EngineOutcome> => {
        asked += 1;
        // Another worker reclaims the lease right before the router reserves spend.
        await owner.query(
          `UPDATE users SET suggest_lease_token = $2,
                  suggest_lease_until = now() + interval '5 minutes'
            WHERE id = $1`,
          [userId, stolenToken],
        );
        return inner.ask(req, signal);
      },
      status: () => inner.status(),
      canSpend: (usd, priority) => inner.canSpend(usd, priority),
      reserveExternalCall: (input) => inner.reserveExternalCall(input),
      recordExternalCall: (call, id) => inner.recordExternalCall(call, id),
      releaseExternalCall: (id) => inner.releaseExternalCall(id),
    });
    const from = fake.requestCount();
    await runSuggest(userId);

    expect(asked).toBeGreaterThan(0);
    expect(await reservations(userId)).toBe(0);
    expect(fake.requestCount()).toBe(from);
    const state = await userState(userId);
    expect(state.last_suggested_at).toBeNull();
    // The release is token-predicated: the reclaiming worker's lease stays.
    expect(state.suggest_lease_token).toBe(stolenToken);
    expect(await suggestions(userId)).toEqual(before);
  });

  it('bulk calls never use the LLM fallback: with the TypeSafe breaker open / no key, no LLM request is made and nothing is written', async () => {
    const openUntil = new Date(Date.now() + 30 * 60_000).toISOString();
    await setSetting('engine.circuit', {
      typesafe: {
        state: 'open',
        openedAt: new Date().toISOString(),
        openUntil,
        reopenCount: 1,
      },
      llm: { state: 'closed', reopenCount: 0 },
      resetRequested: {},
    });
    try {
      // A fresh router (so it reads the stored breaker) with the LLM fallback switched on.
      const llmDeps = depsWith(
        realRouter(
          { ...engineConfig, llmFallbackEnabled: true },
          { typesafe: API_KEY, ollama: OLLAMA_KEY },
        ),
      );
      const userId = await reader({ likes: 4 });
      await seedSuggestion(userId, otherCardId, { score: 0.6 });
      const before = await suggestions(userId);
      const fromTypesafe = fake.requestCount();
      const fromOllama = fakeOllama.requestCount();
      await runSuggest(userId, llmDeps);

      expect(fakeOllama.requestCount()).toBe(fromOllama);
      expect(fake.requestCount()).toBe(fromTypesafe);
      expect(await suggestions(userId)).toEqual(before);
      expect(await engineCalls(userId)).toBe(0);
      const state = await userState(userId);
      expect(state.last_suggested_at).toBeNull();
      expect(state.suggest_lease_token).toBeNull();
    } finally {
      await setSetting('engine.circuit', {
        typesafe: { state: 'closed', reopenCount: 0 },
        llm: { state: 'closed', reopenCount: 0 },
        resetRequested: {},
      });
    }
  });

  it('with card_text_mode english, a library card is offered with its English text and suggested on it', async () => {
    const card = await publicCard('Keramika a hrnčiarstvo', ['transport']);
    await owner.query(
      `UPDATE interest_cards SET body = body || jsonb_build_object('interest_en', $2::text)
        WHERE id = $1`,
      [card.id, 'Zorblax electric trams'],
    );
    await owner.query(`UPDATE interest_cards SET retired_at = now() WHERE id = $1`, [libraryCardId]);
    await setSetting('card_text_mode', 'english');
    try {
      const userId = await reader({ likes: 4 });
      const from = fake.requestCount();
      await runSuggest(userId);

      const sent = JSON.stringify(fake.requests.slice(from).map((request) => request.body));
      expect(sent).toContain('Zorblax electric trams');
      expect(sent).not.toContain('Keramika a hrnčiarstvo');
      const rows = await suggestions(userId);
      expect(rows.map((r) => r.card_id)).toEqual([card.id]);
      expect(rows[0]!.score).toBeCloseTo(0.7, 5);
    } finally {
      await setSetting('card_text_mode', 'as_written');
      await owner.query(`UPDATE interest_cards SET retired_at = now() WHERE id = $1`, [card.id]);
      await owner.query(`UPDATE interest_cards SET retired_at = NULL WHERE id = $1`, [libraryCardId]);
    }
  });

  it('with card_text_mode english, a card with interest_en but a not_for lacking not_for_en is offered with the original pair, never mixed', async () => {
    const card = await createCard(owner, {
      visibility: 'public',
      origin: 'library',
      title: 'Tkanie a výšivky',
      interest: 'Tkanie a výšivky',
      notFor: 'Lacný nábytok',
      topicIds: ['transport'],
      slug: `suggest-${randomUUID()}`,
    });
    // The triggers reject an incomplete pair, so the row is written with them disabled.
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query(`ALTER TABLE interest_cards DISABLE TRIGGER USER`);
      await client.query(
        `UPDATE interest_cards
            SET body = body || jsonb_build_object('interest_en', $2::text)
          WHERE id = $1`,
        [card.id, 'Zorblax electric trams'],
      );
      await client.query(`ALTER TABLE interest_cards ENABLE TRIGGER USER`);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    await owner.query(`UPDATE interest_cards SET retired_at = now() WHERE id = $1`, [libraryCardId]);
    await setSetting('card_text_mode', 'english');
    try {
      const userId = await reader({ likes: 4 });
      const from = fake.requestCount();
      await runSuggest(userId);

      const sent = JSON.stringify(fake.requests.slice(from).map((request) => request.body));
      expect(sent).toContain('Tkanie a výšivky');
      expect(sent).toContain('Lacný nábytok');
      expect(sent).not.toContain('Zorblax electric trams');
    } finally {
      await setSetting('card_text_mode', 'as_written');
      await owner.query(`UPDATE interest_cards SET retired_at = now() WHERE id = $1`, [card.id]);
      await owner.query(`UPDATE interest_cards SET retired_at = NULL WHERE id = $1`, [libraryCardId]);
    }
  });
});
