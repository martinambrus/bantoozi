import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { dispatch } from '../src/handlers/index.js';

import {
  LLM,
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
 * PR #28 Codex round 4, finding 1: the stale-worker guard fences classification on EVERY restart-class
 * value, not only the model. A worker whose booted restart fingerprint differs from the current
 * effective restart-class settings (the condition behind `pendingRestart`) defers the job.
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

async function boot(fallback: boolean) {
  const runtime = await startRuntime({
    db: h.db,
    config: baseConfig('production', {
      llmFallbackEnabled: fallback,
      providerHostAllowlist: ['api.typesafe.ai', 'ollama.com', 'lt2.example.com'],
    }),
    recorder: recorder(),
    selfRestart: false,
  });
  runtimes.push(runtime);
  await h.clearOutbox();
  return runtime;
}

async function demandedArticle(): Promise<string> {
  const feedId = await h.feed();
  const userId = await h.user();
  await h.subscribe(userId, feedId, 'active');
  await h.hold(userId, await h.card({ topicIds: ['technology'] }));
  return h.article({ feedIds: [feedId] });
}

async function enrich(runtime: WorkerRuntimeLike, jobId: string) {
  const articleId = await demandedArticle();
  const router = new ScriptedRouter(h.db, runtime.processModel);
  const error = await dispatch(
    handlersFor(h, runtime, router),
    'article.enrich',
    { articleId },
    { queue: 'article.enrich', jobId },
  ).then(
    () => undefined,
    (e: unknown) => e as { name?: string; retryDelaySeconds?: number },
  );
  return { articleId, router, error };
}

describe('the stale-worker guard fences every restart-class value (PR #28 round 4)', () => {
  it('defers when engine.ollama_models changed (fallback on) while the Jev model did not', async () => {
    const runtime = await boot(true);
    await setSetting(h.owner, 'engine.ollama_models', {
      fast: 'gemma4:31b',
      strong: LLM.strong,
    });
    const { articleId, router, error } = await enrich(runtime, 'r4-a');
    expect(error).toMatchObject({ name: 'StaleWorkerError', retryDelaySeconds: 30 });
    expect(router.asks).toHaveLength(0);
    expect(await h.facetRow(articleId)).toBeNull();
    expect((await h.articleRow(articleId)).state).toBe('extracted');
  });

  it('defers when translate.libretranslate_url changed', async () => {
    const runtime = await boot(false);
    await setSetting(h.owner, 'translate.libretranslate_url', 'https://lt2.example.com');
    const { articleId, router, error } = await enrich(runtime, 'r4-b');
    expect(error).toMatchObject({ name: 'StaleWorkerError', retryDelaySeconds: 30 });
    expect(router.asks).toHaveLength(0);
    expect(await h.facetRow(articleId)).toBeNull();
  });

  it('control: a live-class key (engine.concurrency) changed proceeds', async () => {
    const runtime = await boot(true);
    await setSetting(h.owner, 'engine.concurrency', 4);
    const { articleId, router, error } = await enrich(runtime, 'r4-c');
    expect(error).toBeUndefined();
    expect(router.asksFor(articleId)).toHaveLength(1);
  });

  it('control: nothing changed proceeds', async () => {
    const runtime = await boot(true);
    expect(runtime.models.classification.primaryModel).toBe(OLD_MODEL);
    const { articleId, router, error } = await enrich(runtime, 'r4-d');
    expect(error).toBeUndefined();
    expect(router.asksFor(articleId)).toHaveLength(1);
  });

  it('defers when the stored pin names another fallback model pair than this process records', async () => {
    const runtime = await boot(true);
    await setSetting(h.owner, 'engine.model_pin', {
      model: OLD_MODEL,
      llm: { fast: 'gemma4:31b', strong: LLM.strong },
      since: '2026-10-02T00:00:00.000Z',
    });
    const { error, router } = await enrich(runtime, 'r4-e');
    expect(error).toMatchObject({ name: 'StaleWorkerError', retryDelaySeconds: 30 });
    expect(router.asks).toHaveLength(0);
  });
});
