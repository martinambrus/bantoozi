import {
  startFakeLibreTranslate,
  startFakeOllama,
  type FakeLibreTranslate,
  type FakeOllamaServer,
} from '@bantoozi/testing';
import { createLibreTranslateClient, createOllamaTranslator } from '@bantoozi/translate';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { TranslationDeps } from '../src/classify/translation.js';
import { dispatch } from '../src/handlers/index.js';
import { workerStaleness } from '../src/stale-worker.js';

import { DAY, LLM_MODEL, ago } from './support/classify.js';
import {
  NEW_MODEL,
  OLD_MODEL,
  ClassifyHarness,
  ScriptedRouter,
  baseConfig,
  handlersFor,
  recorder,
  resetWorld,
  setSetting,
  startRuntime,
  type WorkerRuntimeLike,
} from './support/m8b-t5-world.js';

/**
 * `analysis.process` after a Jev flip (FNF[jev-flip-safety] item 1): a still-running old process
 * neither asks its old model nor writes its answers. A stale start leaves the request for a current
 * worker, a flip during the run releases the request without an attempt, and a flip before the
 * completion publishes nothing.
 */

const V2 = 'jev-2.0.0';
const LT2 = 'https://lt2.example.com';

let h: ClassifyHarness;
let lt: FakeLibreTranslate;
let ollama: FakeOllamaServer;
let translation: TranslationDeps;
const runtimes: WorkerRuntimeLike[] = [];
const closers: Array<() => Promise<void>> = [];

beforeAll(async () => {
  lt = await startFakeLibreTranslate();
  ollama = await startFakeOllama({ apiKey: 'test-key', reply: () => '{}' });
  const libretranslate = createLibreTranslateClient({ baseUrl: lt.url, maxAttempts: 1 });
  const translator = createOllamaTranslator({ baseUrl: ollama.url });
  closers.push(
    () => libretranslate.close(),
    () => translator.close(),
    () => lt.close(),
    () => ollama.close(),
  );
  translation = {
    libretranslate,
    ollama: translator,
    credentials: {
      metadata: async () => ({ source: 'none', enabled: false }) as never,
      useActive: async () => {
        throw new Error('tier 2 is not used here');
      },
      useCandidate: async () => {
        throw new Error('candidate keys are not used here');
      },
    },
    modelFast: LLM_MODEL,
    modelStrong: 'glm-5.3',
  };
  h = await ClassifyHarness.start({
    languageModes: { en: 'native', sk: 'translate', cs: 'native' },
  });
}, 240_000);

afterAll(async () => {
  for (const runtime of runtimes) await runtime.close().catch(() => undefined);
  await h?.close();
  for (const close of closers) await close();
});

beforeEach(async () => {
  await resetWorld(h);
  lt.reset({ mode: 'ok' });
});

afterEach(async () => {
  await h.owner.query('DROP TRIGGER IF EXISTS flip_pin_on_claim ON analysis_requests');
  await h.owner.query('DROP FUNCTION IF EXISTS flip_pin_on_claim()');
});

async function boot(model = OLD_MODEL, overrides: Parameters<typeof baseConfig>[1] = {}) {
  const runtime = await startRuntime({
    db: h.db,
    config: baseConfig('production', {
      typesafeModel: model,
      providerHostAllowlist: ['api.typesafe.ai', 'ollama.com', 'lt2.example.com'],
      ...overrides,
    }),
    recorder: recorder(),
    selfRestart: false,
  });
  runtimes.push(runtime);
  return runtime;
}

const flipPin = (model = NEW_MODEL) =>
  setSetting(h.owner, 'engine.model_pin', { model, since: new Date().toISOString() });

let titles = 0;

async function trainee(options: { lang?: string; text?: Record<string, string> } = {}) {
  const feedId = await h.feed();
  const userId = await h.user();
  await h.subscribe(userId, feedId, 'training');
  const cardId = await h.heldCard(userId, { topicIds: ['technology'] });
  titles += 1;
  const articleId = await h.article({
    feedIds: [feedId],
    title: `Fence story number ${titles} about wind turbines`,
    firstSeenAt: ago(3 * DAY),
    ...(options.lang === undefined ? {} : { lang: options.lang }),
    ...(options.text ?? {}),
  });
  return { feedId, userId, cardId, articleId };
}

type Trainee = Awaited<ReturnType<typeof trainee>>;

/** A request frozen under `model`, with the select's own immediate intent removed. */
async function frozen(t: Trainee, model: string): Promise<string> {
  const { requestId } = await h.select(t.userId, t.feedId, t.articleId, model);
  await h.clearOutbox();
  return requestId;
}

function run(runtime: WorkerRuntimeLike, router: ScriptedRouter, requestId: string) {
  return dispatch(
    handlersFor(h, runtime, router),
    'analysis.process',
    { analysisRequestId: requestId },
    { queue: 'analysis.process', jobId: 'fence' },
  );
}

async function pendingIntents(requestId: string) {
  const result = await h.owner.query<{ seconds: number }>(
    `SELECT extract(epoch FROM available_at - now())::float AS seconds FROM job_outbox
      WHERE queue = 'analysis.process' AND delivered_at IS NULL AND payload ->> 'analysisRequestId' = $1`,
    [requestId],
  );
  return result.rows.map((row) => row.seconds);
}

async function expectLeftForCurrentWorker(requestId: string, errorCode: string | null) {
  expect(await h.analysis(requestId)).toMatchObject({
    status: 'pending',
    attempts: 0,
    leaseToken: null,
    leaseUntil: null,
    lastErrorCode: errorCode,
    resultSnapshot: null,
    resultSha: null,
  });
  const delays = await pendingIntents(requestId);
  expect(delays).toHaveLength(1);
  expect(delays[0]).toBeGreaterThan(20);
  expect(delays[0]).toBeLessThanOrEqual(31);
}

async function sharedRows(articleId: string) {
  const rows = async (sql: string) =>
    (await h.owner.query<{ r: unknown }>(sql, [articleId])).rows.map((row) => row.r);
  return {
    facets: await rows(
      'SELECT to_jsonb(t) AS r FROM article_facets t WHERE article_id = $1 ORDER BY 1',
    ),
    cards: await rows(
      'SELECT to_jsonb(t) AS r FROM card_answers t WHERE article_id = $1 ORDER BY card_id',
    ),
    l2: await rows(
      'SELECT to_jsonb(t) AS r FROM article_topics_l2 t WHERE article_id = $1 ORDER BY l1_id',
    ),
  };
}

describe('S1: stale at the start', () => {
  it.each([
    ['the model pin moved', async () => flipPin()],
    [
      'a restart-class setting moved',
      async () => setSetting(h.owner, 'translate.libretranslate_url', LT2),
    ],
  ])('%s: nothing is claimed or asked, one delayed intent is left', async (_name, flip) => {
    const runtime = await boot();
    const router = new ScriptedRouter(h.db, runtime.processModel);
    const t = await trainee();
    const requestId = await frozen(t, OLD_MODEL);
    await flip();

    await run(runtime, router, requestId);

    expect(router.asks).toEqual([]);
    await expectLeftForCurrentWorker(requestId, null);
    expect(await h.facetRow(t.articleId)).toBeNull();
    expect(await h.cardAnswers(t.articleId)).toEqual([]);
    expect(await h.l2Rows(t.articleId)).toEqual([]);
  });

  it('control: no flip completes with both calls', async () => {
    const runtime = await boot();
    const router = new ScriptedRouter(h.db, runtime.processModel);
    const t = await trainee();
    const requestId = await frozen(t, OLD_MODEL);

    await run(runtime, router, requestId);

    expect(router.asks.map((ask) => ask.kind)).toEqual(['enrich', 'match']);
    expect((await h.analysis(requestId)).status).toBe('complete');
  });
});

describe('S2: a request frozen under the new major is not failed by a stale process', () => {
  it('stale V13 process, pin on jev-2.0.0: left pending', async () => {
    const runtime = await boot();
    const router = new ScriptedRouter(h.db, runtime.processModel);
    const t = await trainee();
    const requestId = await frozen(t, V2);
    await flipPin(V2);

    await run(runtime, router, requestId);

    expect(router.asks).toEqual([]);
    await expectLeftForCurrentWorker(requestId, null);
  });

  it('control: a current V13 process still fails it with context_unavailable', async () => {
    const runtime = await boot();
    const router = new ScriptedRouter(h.db, runtime.processModel);
    const t = await trainee();
    const requestId = await frozen(t, V2);

    await run(runtime, router, requestId);

    expect(router.asks).toEqual([]);
    expect(await h.analysis(requestId)).toMatchObject({
      status: 'failed',
      lastErrorCode: 'context_unavailable',
    });
  });
});

describe('S3: a flip during Call A', () => {
  it('stops before Call B, keeps nothing shared, and a current process resumes', async () => {
    const runtime = await boot();
    const router = new ScriptedRouter(h.db, runtime.processModel);
    const t = await trainee();
    const requestId = await frozen(t, OLD_MODEL);
    router.respond = async () => {
      await flipPin();
      return undefined;
    };

    await run(runtime, router, requestId);

    expect(router.asksFor(t.articleId).map((ask) => ask.kind)).toEqual(['enrich']);
    await expectLeftForCurrentWorker(requestId, 'stale_worker');
    const deferred = await h.analysis(requestId);
    expect(deferred.stageResults).toMatchObject({ model: OLD_MODEL });
    expect(deferred.stageResults?.['enrich']).toBeDefined();
    expect(await h.facetRow(t.articleId)).toBeNull();
    expect(await h.cardAnswers(t.articleId)).toEqual([]);
    expect(await h.l2Rows(t.articleId)).toEqual([]);

    const next = await boot(NEW_MODEL);
    const nextRouter = new ScriptedRouter(h.db, next.processModel);
    await h.owner.query('UPDATE analysis_requests SET next_attempt_at = now() WHERE id = $1', [
      requestId,
    ]);
    await run(next, nextRouter, requestId);

    expect(router.asks.length + nextRouter.asks.length).toBe(3);
    expect(nextRouter.asks.map((ask) => ask.kind)).toEqual(['enrich', 'match']);
    const done = await h.analysis(requestId);
    expect(done.status).toBe('complete');
    expect(done.resultSnapshot).toMatchObject({ model: { engine: 'typesafe', model: NEW_MODEL } });
    expect(done.stageResults).toMatchObject({ model: NEW_MODEL });
    expect(await h.facetRow(t.articleId)).toMatchObject({ model: NEW_MODEL });
  });
});

describe('S4: a flip during the last call', () => {
  it('the completion discards and the new-stamped rows stay untouched', async () => {
    const runtime = await boot();
    const router = new ScriptedRouter(h.db, runtime.processModel);
    const t = await trainee();
    await h.enrichDirect(t.articleId, { model: NEW_MODEL, state: 'extracted' });
    await h.answerCard(t.articleId, t.cardId, {
      engine: 'typesafe',
      model: NEW_MODEL,
      p: 0.33,
    });
    await h.answerL2(t.articleId, 'technology', { engine: 'typesafe', model: NEW_MODEL });
    const before = await sharedRows(t.articleId);
    expect(before.facets).toHaveLength(1);
    expect(before.cards).toHaveLength(1);
    expect(before.l2).toHaveLength(1);
    const requestId = await frozen(t, OLD_MODEL);
    router.respond = async (ask) => {
      if (ask.kind === 'match') await flipPin();
      return undefined;
    };

    await run(runtime, router, requestId);

    expect(router.asks.map((ask) => ask.kind)).toEqual(['enrich', 'match']);
    expect(await sharedRows(t.articleId)).toEqual(before);
    await expectLeftForCurrentWorker(requestId, 'stale_worker');
  });
});

describe('S5: the translation tier is fenced', () => {
  it('a flip between the claim and tier 1 makes no external call', async () => {
    const runtime = await boot();
    const router = new ScriptedRouter(h.db, runtime.processModel);
    const t = await trainee({
      lang: 'sk',
      text: {
        title: 'Nové električky v Bratislave jazdia od pondelka',
        excerpt: 'Od pondelka jazdia na petržalskej trati prvé nové nízkopodlažné električky.',
        bodyLead:
          'Od pondelka jazdia na petržalskej trati prvé nové nízkopodlažné električky. Dopravný ' +
          'podnik ich nasadil najskôr na linku, ktorá vedie cez Starý most.',
      },
    });
    const requestId = await frozen(t, OLD_MODEL);
    await h.owner.query(`
      CREATE FUNCTION flip_pin_on_claim() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
      BEGIN
        UPDATE settings SET value = '{"model":"${NEW_MODEL}","since":"2026-10-23T00:00:00.000Z"}'::jsonb
         WHERE key = 'engine.model_pin';
        RETURN NEW;
      END $$`);
    await h.owner.query(`
      CREATE TRIGGER flip_pin_on_claim AFTER UPDATE OF status ON analysis_requests
      FOR EACH ROW WHEN (NEW.status = 'running') EXECUTE FUNCTION flip_pin_on_claim()`);

    await dispatch(
      h.handlersWith({
        classification: { ...runtime.models.classification, router, translation },
      }),
      'analysis.process',
      { analysisRequestId: requestId },
      { queue: 'analysis.process', jobId: 'fence' },
    );

    expect(router.external).toEqual([]);
    expect(lt.requests).toHaveLength(0);
    expect(router.asks).toEqual([]);
    await expectLeftForCurrentWorker(requestId, 'stale_worker');
  });
});

describe('S6: workerStaleness', () => {
  it('is null without a pin row and without currentness', async () => {
    await h.owner.query(`DELETE FROM settings WHERE key = 'engine.model_pin'`);
    expect(await workerStaleness(h.db, { primaryModel: OLD_MODEL })).toBeNull();
  });

  it('reports the pin and the restart-class change', async () => {
    const runtime = await boot();
    const classification = runtime.models.classification;
    expect(await workerStaleness(h.db, classification)).toBeNull();

    await setSetting(h.owner, 'translate.libretranslate_url', LT2);
    expect(await workerStaleness(h.db, classification)).toMatchObject({
      name: 'StaleWorkerError',
      reason: 'restart_settings',
      retryDelaySeconds: 30,
    });
    await h.owner.query(`DELETE FROM settings WHERE key = 'translate.libretranslate_url'`);

    await flipPin();
    expect(await workerStaleness(h.db, classification)).toMatchObject({
      reason: 'pin',
      processModel: OLD_MODEL,
      pinnedModel: NEW_MODEL,
    });
    expect(await workerStaleness(h.db, { primaryModel: OLD_MODEL })).toMatchObject({
      reason: 'pin',
    });
  });
});
