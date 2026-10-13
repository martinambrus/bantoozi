import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { dispatch } from '../src/handlers/index.js';

import { HOUR, ago } from './support/classify.js';
import {
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
 * PR #28 Codex round 7, finding 1: `article.cluster` carries the stale-worker guards of enrich and
 * match. The start refuses a process that is not what the database asks for, and the completion
 * transaction discards a fold decided while a restart-class value moved (no fold, `StaleWorkerError`).
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

async function boot() {
  const runtime = await startRuntime({
    db: h.db,
    config: baseConfig('production', {
      providerHostAllowlist: ['api.typesafe.ai', 'ollama.com', 'ts2.example.com'],
    }),
    recorder: recorder(),
    selfRestart: false,
  });
  runtimes.push(runtime);
  await h.clearOutbox();
  return runtime;
}

/** A demanded article with one folding candidate; `change` runs while the provider works. */
async function clusterWhileChanging(
  runtime: WorkerRuntimeLike,
  jobId: string,
  change: (() => Promise<void>) | undefined,
  beforeStart?: () => Promise<void>,
) {
  // Unique per test: earlier tests' articles stay in the database and would be better candidates.
  const title = `Volcanic ash cloud grounds flights across northern Iceland ${jobId}`;
  const readerFeed = await h.feed('Home desk');
  const otherFeed = await h.feed('Feed A');
  const userId = await h.user();
  await h.subscribe(userId, readerFeed, 'active');
  const otherUser = await h.user();
  await h.subscribe(otherUser, otherFeed, 'active');
  const candidate = await h.article({ feedIds: [otherFeed], title, firstSeenAt: ago(2 * HOUR) });
  await h.enrichDirect(candidate);
  const articleId = await h.article({ feedIds: [readerFeed], title, firstSeenAt: ago(HOUR) });
  await h.enrichDirect(articleId);
  await beforeStart?.();
  const router = new ScriptedRouter(h.db, runtime.processModel);
  router.clusterChoice = 'c1';
  router.respond = async () => {
    await change?.();
    return undefined;
  };
  const error = await dispatch(
    handlersFor(h, runtime, router),
    'article.cluster',
    { articleId },
    { queue: 'article.cluster', jobId },
  ).then(
    () => undefined,
    (e: unknown) => e as { name?: string; retryDelaySeconds?: number },
  );
  return { articleId, candidate, router, error };
}

describe('article.cluster stale-worker guards (PR #28 round 7)', () => {
  it('discards the fold when a restart-class value changed in flight', async () => {
    const runtime = await boot();
    const { articleId, candidate, router, error } = await clusterWhileChanging(
      runtime,
      'r7-c1',
      () => setSetting(h.owner, 'engine.typesafe_base_url', 'https://ts2.example.com'),
    );
    expect(router.asksFor(articleId, 'cluster')).toHaveLength(1);
    expect(error).toMatchObject({ name: 'StaleWorkerError', retryDelaySeconds: 30 });
    expect((await h.articleRow(articleId)).clusterId).toBeNull();
    expect((await h.articleRow(candidate)).clusterId).toBeNull();
  });

  it('refuses before the model call when the pin already names another model', async () => {
    const runtime = await boot();
    const { articleId, router, error } = await clusterWhileChanging(
      runtime,
      'r7-c2',
      undefined,
      () =>
        setSetting(h.owner, 'engine.model_pin', {
          model: 'jev-9.9.9',
          since: '2026-10-02T00:00:00.000Z',
        }),
    );
    expect(error).toMatchObject({ name: 'StaleWorkerError' });
    expect(router.asksFor(articleId)).toHaveLength(0);
  });

  it('control: a live-class key changed in flight still folds', async () => {
    const runtime = await boot();
    const { articleId, candidate, error } = await clusterWhileChanging(runtime, 'r7-c3', () =>
      setSetting(h.owner, 'engine.concurrency', 4),
    );
    expect(error).toBeUndefined();
    const placed = await h.articleRow(articleId);
    expect(placed.clusterId).not.toBeNull();
    expect((await h.articleRow(candidate)).clusterId).toBe(placed.clusterId);
  });
});
