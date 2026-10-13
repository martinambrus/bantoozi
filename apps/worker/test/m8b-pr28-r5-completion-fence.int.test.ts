import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { dispatch } from '../src/handlers/index.js';

import { NO_BRANCH_TOPICS } from './support/classify.js';
import {
  LLM,
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
 * PR #28 Codex round 5, finding 1: the stale-worker check also holds at the completion. A restart-class
 * value (or the pin, llm included) that changes while the model call is in flight discards the answer:
 * nothing is written and the job fails with `StaleWorkerError`, so the queue retries it later.
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
      providerHostAllowlist: [
        'api.typesafe.ai',
        'ollama.com',
        'lt2.example.com',
        'ts2.example.com',
      ],
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

/** Enrich with `change` applied while the provider call is in flight. */
async function enrichWhileChanging(
  runtime: WorkerRuntimeLike,
  jobId: string,
  change: () => Promise<void>,
) {
  const articleId = await demandedArticle();
  const router = new ScriptedRouter(h.db, runtime.processModel);
  router.respond = async () => {
    await change();
    return undefined;
  };
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

/** A match completion with `change` applied while the pack is in flight. */
async function matchWhileChanging(
  runtime: WorkerRuntimeLike,
  jobId: string,
  change: () => Promise<void>,
) {
  const feedId = await h.feed();
  const userId = await h.user();
  await h.subscribe(userId, feedId, 'active');
  const cardId = await h.heldCard(userId, { topicIds: ['technology.ai_ml'] });
  const articleId = await h.article({ feedIds: [feedId] });
  await h.enrichDirect(articleId, { topics: NO_BRANCH_TOPICS });
  await h.queue(articleId, [cardId]);
  const router = new ScriptedRouter(h.db, runtime.processModel);
  router.respond = async () => {
    await change();
    return undefined;
  };
  const error = await dispatch(
    handlersFor(h, runtime, router),
    'article.match',
    { articleId },
    { queue: 'article.match', jobId },
  ).then(
    () => undefined,
    (e: unknown) => e as { name?: string; retryDelaySeconds?: number },
  );
  return { articleId, router, error };
}

describe('the completion re-checks the stale-worker guard (PR #28 round 5)', () => {
  it('discards the answer when engine.typesafe_base_url changed in flight', async () => {
    const runtime = await boot(false);
    const { articleId, router, error } = await enrichWhileChanging(runtime, 'r5-a', () =>
      setSetting(h.owner, 'engine.typesafe_base_url', 'https://ts2.example.com'),
    );
    expect(router.asksFor(articleId)).toHaveLength(1);
    expect(error).toMatchObject({ name: 'StaleWorkerError', retryDelaySeconds: 30 });
    expect(await h.facetRow(articleId)).toBeNull();
    expect((await h.articleRow(articleId)).state).toBe('extracted');
  });

  it('discards the answer when translate.libretranslate_url changed in flight', async () => {
    const runtime = await boot(false);
    const { articleId, error } = await enrichWhileChanging(runtime, 'r5-b', () =>
      setSetting(h.owner, 'translate.libretranslate_url', 'https://lt2.example.com'),
    );
    expect(error).toMatchObject({ name: 'StaleWorkerError', retryDelaySeconds: 30 });
    expect(await h.facetRow(articleId)).toBeNull();
  });

  it('discards the answer when the pin names another fallback pair in flight', async () => {
    const runtime = await boot(true);
    const { articleId, error } = await enrichWhileChanging(runtime, 'r5-c', () =>
      setSetting(h.owner, 'engine.model_pin', {
        model: runtime.processModel,
        llm: { fast: 'gemma4:31b', strong: LLM.strong },
        since: '2026-10-02T00:00:00.000Z',
      }),
    );
    expect(error).toMatchObject({ name: 'StaleWorkerError', retryDelaySeconds: 30 });
    expect(await h.facetRow(articleId)).toBeNull();
  });

  it('control: a live-class key (engine.concurrency) changed in flight writes the answer', async () => {
    const runtime = await boot(true);
    const { articleId, error } = await enrichWhileChanging(runtime, 'r5-d', () =>
      setSetting(h.owner, 'engine.concurrency', 4),
    );
    expect(error).toBeUndefined();
    expect(await h.facetRow(articleId)).not.toBeNull();
    expect((await h.articleRow(articleId)).state).toBe('enriched');
  });

  it('control: nothing changed writes the answer', async () => {
    const runtime = await boot(false);
    const { articleId, error } = await enrichWhileChanging(runtime, 'r5-e', async () => {});
    expect(error).toBeUndefined();
    expect(await h.facetRow(articleId)).not.toBeNull();
  });

  it('match: discards the pack and releases the rows when a restart-class value changed in flight', async () => {
    const runtime = await boot(false);
    const { articleId, router, error } = await matchWhileChanging(runtime, 'r5-m1', () =>
      setSetting(h.owner, 'engine.typesafe_base_url', 'https://ts2.example.com'),
    );
    expect(router.asksFor(articleId, 'match')).toHaveLength(1);
    expect(error).toMatchObject({ name: 'StaleWorkerError', retryDelaySeconds: 30 });
    expect(await h.cardAnswers(articleId)).toEqual([]);
  });

  it('match control: a live-class key changed in flight writes the answer', async () => {
    const runtime = await boot(false);
    const { articleId, error } = await matchWhileChanging(runtime, 'r5-m2', () =>
      setSetting(h.owner, 'engine.concurrency', 4),
    );
    expect(error).toBeUndefined();
    expect(await h.cardAnswers(articleId)).toHaveLength(1);
  });
});
