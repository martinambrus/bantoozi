import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { dispatch } from '../src/handlers/index.js';

import {
  NEW_MODEL,
  OLD_MODEL,
  ClassifyHarness,
  ScriptedRouter,
  baseConfig,
  expectedDedupeKey,
  handlersFor,
  pinRow,
  rebuildIntents,
  recorder,
  resetWorld,
  setSetting,
  startRuntime,
  type WorkerRuntimeLike,
} from './support/m8b-t5-world.js';

/**
 * M8b-T5 (PLAN §14.2, scope B2 "Class R"): the restart-class values (model, base URLs, fallback,
 * Ollama models and concurrency, LibreTranslate URL) apply by a drained worker self-restart. Two
 * in-process runtimes stand for two worker processes on one database (the M8-F12 pattern in
 * `two-workers.int.test.ts`); the process exit is an injected seam, so a test asserts that exit WAS
 * requested and never kills itself. A "restart" is a new `createWorkerRuntime` on the same database.
 * The seams are documented in `support/m8b-t5-world.ts`.
 */
let h: ClassifyHarness;
const runtimes: WorkerRuntimeLike[] = [];

beforeAll(async () => {
  h = await ClassifyHarness.start();
}, 240_000);

afterAll(async () => {
  for (const runtime of runtimes) await runtime.close().catch(() => undefined);
  await h?.close();
});

beforeEach(async () => {
  await resetWorld(h);
});

async function boot(
  nodeEnv: 'test' | 'production',
  rec = recorder(),
  extra: { selfRestart?: boolean } = {},
) {
  const runtime = await startRuntime({
    db: h.db,
    config: baseConfig(nodeEnv),
    recorder: rec,
    ...extra,
  });
  runtimes.push(runtime);
  return { runtime, rec };
}

/** An active reader of a new feed and an extracted article of it, demanded and ready for Call A. */
async function demandedArticle(): Promise<string> {
  const feedId = await h.feed();
  const userId = await h.user();
  await h.subscribe(userId, feedId, 'active');
  await h.hold(userId, await h.card({ topicIds: ['technology'] }));
  return h.article({ feedIds: [feedId] });
}

describe('startup builds from the effective values', () => {
  it('uses the stored model for the process, the classification deps and the pin; null falls back to the env', async () => {
    await h.owner.query(`DELETE FROM settings WHERE key = 'engine.model_pin'`);
    await setSetting(h.owner, 'engine.typesafe_model', NEW_MODEL);
    const { runtime } = await boot('test');
    expect(runtime.processModel).toBe(NEW_MODEL);
    expect(runtime.models.classification.primaryModel).toBe(NEW_MODEL);
    expect(await pinRow(h.owner)).toMatchObject({ model: NEW_MODEL });
    // A missing pin row is inserted without a rebuild (spec 11 §8).
    expect(await rebuildIntents(h.owner)).toEqual([]);

    await setSetting(h.owner, 'engine.typesafe_model', null);
    const reset = await boot('test');
    expect(reset.runtime.processModel).toBe(OLD_MODEL);
    expect(reset.runtime.models.classification.primaryModel).toBe(OLD_MODEL);
  });

  it('leaves the pin and the outbox alone when recordPin is false (eval ingest-only)', async () => {
    await setSetting(h.owner, 'engine.typesafe_model', NEW_MODEL);
    const runtime = await startRuntime({
      db: h.db,
      config: baseConfig('test'),
      recorder: recorder(),
      recordPin: false,
    });
    runtimes.push(runtime);
    expect(runtime.processModel).toBe(NEW_MODEL);
    expect(await pinRow(h.owner)).toMatchObject({ model: OLD_MODEL });
    expect(await rebuildIntents(h.owner)).toEqual([]);
  });
});

describe('a changed restart-class model (production, two workers)', () => {
  it('makes both workers drain and exit(0) exactly once, then one reenrich and one rematch with revision = since and the pin at the new model', async () => {
    const a1 = await boot('production');
    const b1 = await boot('production');
    // Control: nothing changed yet. No restart, no rebuild, the pin still the old model.
    expect((await a1.runtime.check()).pendingRestart).toBe(false);
    expect((await b1.runtime.check()).pendingRestart).toBe(false);
    expect(a1.rec.exits).toEqual([]);
    expect(b1.rec.exits).toEqual([]);
    expect(await rebuildIntents(h.owner)).toEqual([]);

    await setSetting(h.owner, 'engine.typesafe_model', NEW_MODEL);

    // The watcher ticks several times: each worker requests ONE restart, drained before exit.
    for (const w of [a1, b1]) {
      expect(await w.runtime.check()).toMatchObject({ pendingRestart: true, exiting: true });
      await w.runtime.check();
      await w.runtime.check();
      expect(w.rec.exits).toEqual([0]);
      expect(w.rec.drains).toBe(1);
      expect(w.rec.calls).toEqual(['drain', 'exit']);
    }
    // Nothing is written by the old processes.
    expect(await pinRow(h.owner)).toMatchObject({ model: OLD_MODEL });
    expect(await rebuildIntents(h.owner)).toEqual([]);

    // Compose restarts the containers: first worker, then the second.
    const a2 = await boot('production');
    const b2 = await boot('production');
    expect(a2.runtime.processModel).toBe(NEW_MODEL);
    expect(b2.runtime.processModel).toBe(NEW_MODEL);

    const pin = await pinRow(h.owner);
    expect(pin?.model).toBe(NEW_MODEL);
    expect(pin?.since).not.toBe('2026-10-01T00:00:00.000Z');
    expect(await rebuildIntents(h.owner)).toEqual([
      {
        queue: 'house.reenrich',
        payload: {},
        dedupeKey: expectedDedupeKey('house.reenrich', pin!.since),
      },
      {
        queue: 'house.rematch',
        payload: {},
        dedupeKey: expectedDedupeKey('house.rematch', pin!.since),
      },
    ]);
  });

  it('does not restart in a loop: after the restart the fingerprints match and nothing exits', async () => {
    const before = await boot('production');
    await setSetting(h.owner, 'engine.typesafe_model', NEW_MODEL);
    await before.runtime.check();
    expect(before.rec.exits).toEqual([0]);

    const after = await boot('production');
    expect(after.runtime.fingerprint).not.toBe(before.runtime.fingerprint);
    for (let i = 0; i < 3; i += 1) {
      expect(await after.runtime.check()).toMatchObject({ pendingRestart: false, exiting: false });
    }
    expect(after.rec.exits).toEqual([]);
    expect(after.rec.drains).toBe(0);
    expect(after.runtime.heartbeatRuntime().pendingRestart).toBe(false);
  });
});

describe('the stale-worker guard', () => {
  it('defers article.enrich and house.reenrich on a worker whose model differs from the pin, writing no answer; a current worker proceeds', async () => {
    const stale = await boot('production');
    const articleId = await demandedArticle();
    const staleRouter = new ScriptedRouter(h.db, stale.runtime.processModel);

    // Control: pin == process model, the job runs and asks the router.
    await dispatch(
      handlersFor(h, stale.runtime, staleRouter),
      'article.enrich',
      { articleId },
      {
        queue: 'article.enrich',
        jobId: 'control',
      },
    );
    expect(staleRouter.asksFor(articleId)).toHaveLength(1);
    expect((await h.articleRow(articleId)).state).toBe('enriched');

    // The model changes and the first worker restarts and records the pin.
    await setSetting(h.owner, 'engine.typesafe_model', NEW_MODEL);
    const fresh = await boot('production');
    expect((await pinRow(h.owner))?.model).toBe(NEW_MODEL);
    await h.clearOutbox();

    const second = await demandedArticle();
    staleRouter.reset();
    const staleHandlers = handlersFor(h, stale.runtime, staleRouter);
    const refusal = await dispatch(
      staleHandlers,
      'article.enrich',
      { articleId: second },
      { queue: 'article.enrich', jobId: 'stale-1' },
    ).then(
      () => undefined,
      (error: unknown) => error as { name?: string; retryDelaySeconds?: number },
    );
    expect(refusal).toMatchObject({ name: 'StaleWorkerError', retryDelaySeconds: 30 });
    expect(staleRouter.asks).toHaveLength(0);
    expect(await h.facetRow(second)).toBeNull();
    expect((await h.articleRow(second)).state).toBe('extracted');

    // The rebuild a restarted worker enqueued must not run on the stale one either.
    const mark = await h.mark();
    const reenrich = await dispatch(
      staleHandlers,
      'house.reenrich',
      {},
      {
        queue: 'house.reenrich',
        jobId: 'stale-2',
      },
    ).then(
      () => undefined,
      (error: unknown) => error as { name?: string },
    );
    expect(reenrich).toMatchObject({ name: 'StaleWorkerError' });
    expect(await h.intents('article.enrich', { since: mark })).toEqual([]);

    // Control: the restarted worker, whose model equals the pin, processes the same article.
    const freshRouter = new ScriptedRouter(h.db, fresh.runtime.processModel);
    await dispatch(
      handlersFor(h, fresh.runtime, freshRouter),
      'article.enrich',
      {
        articleId: second,
      },
      { queue: 'article.enrich', jobId: 'fresh-1' },
    );
    expect(freshRouter.asksFor(second)).toHaveLength(1);
    expect((await h.articleRow(second)).state).toBe('enriched');
  });

  it('does not treat a missing pin row as stale', async () => {
    await h.owner.query(`DELETE FROM settings WHERE key = 'engine.model_pin'`);
    const { runtime } = await boot('test', recorder(), {});
    await h.owner.query(`DELETE FROM settings WHERE key = 'engine.model_pin'`);
    const articleId = await demandedArticle();
    const router = new ScriptedRouter(h.db, runtime.processModel);
    await dispatch(
      handlersFor(h, runtime, router),
      'article.enrich',
      { articleId },
      {
        queue: 'article.enrich',
        jobId: 'no-pin',
      },
    );
    expect(router.asksFor(articleId)).toHaveLength(1);
  });
});

describe('an invalid stored value', () => {
  it.each([
    ['an unpinned model id in production', 'jev-beta'],
    ['a value of the wrong type', { model: NEW_MODEL }],
    ['an empty string', ''],
  ])('%s is ignored, reported in runtime.problems, and causes no restart', async (_name, value) => {
    const { runtime, rec } = await boot('production');
    await setSetting(h.owner, 'engine.typesafe_model', value);
    expect(await runtime.check()).toMatchObject({ pendingRestart: false, exiting: false });
    expect(rec.exits).toEqual([]);
    expect(rec.drains).toBe(0);
    const reported = runtime.heartbeatRuntime();
    expect(reported.pendingRestart).toBe(false);
    expect(reported.model).toBe(OLD_MODEL);
    expect(reported.problems.map((p) => p.key)).toContain('engine.typesafe_model');

    // A worker that starts with the invalid row boots with the previous value (env) and reports it.
    const restarted = await boot('production');
    expect(restarted.runtime.processModel).toBe(OLD_MODEL);
    expect(restarted.runtime.heartbeatRuntime().problems.map((p) => p.key)).toContain(
      'engine.typesafe_model',
    );
    expect(await pinRow(h.owner)).toMatchObject({ model: OLD_MODEL });
    expect(await rebuildIntents(h.owner)).toEqual([]);
  });

  it('control: once the row is valid again the problem clears', async () => {
    const { runtime } = await boot('production');
    await setSetting(h.owner, 'engine.typesafe_model', 'jev-beta');
    await runtime.check();
    expect(runtime.heartbeatRuntime().problems).not.toEqual([]);
    await setSetting(h.owner, 'engine.typesafe_model', null);
    await runtime.check();
    expect(runtime.heartbeatRuntime().problems).toEqual([]);
  });
});

describe('the jev-latest alias as a stored value (JEV-2)', () => {
  it('is accepted in production: no validation problem, and the changed configured model asks for one restart', async () => {
    const { runtime, rec } = await boot('production');
    await setSetting(h.owner, 'engine.typesafe_model', 'jev-latest');
    expect(await runtime.check()).toMatchObject({ pendingRestart: true, exiting: true });
    expect(rec.exits).toEqual([0]);
    expect(rec.drains).toBe(1);
    expect(runtime.heartbeatRuntime().problems.map((p) => p.key)).not.toContain(
      'engine.typesafe_model',
    );
  });

  it('control: another non-concrete id is still refused in production, with no restart', async () => {
    const { runtime, rec } = await boot('production');
    await setSetting(h.owner, 'engine.typesafe_model', 'jev-beta');
    expect(await runtime.check()).toMatchObject({ pendingRestart: false, exiting: false });
    expect(rec.exits).toEqual([]);
    expect(runtime.heartbeatRuntime().problems.map((p) => p.key)).toContain(
      'engine.typesafe_model',
    );
  });
});

describe('outside production, or with self restart off', () => {
  it('logs pendingRestart and reports it in the heartbeat, but never drains or exits', async () => {
    const { runtime, rec } = await boot('test');
    await setSetting(h.owner, 'engine.typesafe_model', NEW_MODEL);
    expect(await runtime.check()).toEqual({ pendingRestart: true, exiting: false });
    await runtime.check();
    expect(rec.exits).toEqual([]);
    expect(rec.drains).toBe(0);
    expect(runtime.heartbeatRuntime().pendingRestart).toBe(true);
    expect(runtime.processModel).toBe(OLD_MODEL);
    expect(
      rec.logs.some((entry) => entry.level === 'warn' && entry.obj['pendingRestart'] === true),
    ).toBe(true);
  });

  it('WORKER_SELF_RESTART=false in production behaves the same (selfRestart: false)', async () => {
    const { runtime, rec } = await boot('production', recorder(), { selfRestart: false });
    await setSetting(h.owner, 'engine.typesafe_model', NEW_MODEL);
    expect(await runtime.check()).toEqual({ pendingRestart: true, exiting: false });
    expect(rec.exits).toEqual([]);
    expect(rec.drains).toBe(0);
    expect(runtime.heartbeatRuntime().pendingRestart).toBe(true);
  });
});

describe('which keys are restart class', () => {
  it.each([
    ['engine.typesafe_base_url', 'https://api.typesafe.ai/v2', true],
    ['engine.llm_fallback_enabled', true, true],
    ['engine.ollama_models', { fast: 'glm-5.3', strong: 'glm-5.3-flash' }, true],
    ['engine.ollama_base_url', 'https://ollama.com/api', true],
    ['engine.ollama_max_concurrency', 3, true],
    ['translate.libretranslate_url', 'http://libretranslate-2:5000', true],
    // Negative controls: live-class keys never ask for a restart.
    ['engine.concurrency', 4, false],
    ['engine.typesafe_price_per_mtok_usd', 0.05, false],
    ['engine.prefilter_min_cards', 80, false],
    ['ingest.max_age_days', 30, false],
    ['fetch.limits', { timeoutMs: 20_000, maxBytes: 1_048_576 }, false],
  ] as const)('%s -> pendingRestart %s', async (key, value, restart) => {
    const { runtime, rec } = await boot('test');
    await setSetting(h.owner, key, value);
    expect((await runtime.check()).pendingRestart).toBe(restart);
    expect(runtime.heartbeatRuntime().pendingRestart).toBe(restart);
    expect(rec.exits).toEqual([]);
  });
});
