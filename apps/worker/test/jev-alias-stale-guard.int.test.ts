import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatch } from '../src/handlers/index.js';

import {
  NEW_MODEL,
  OLD_MODEL,
  ClassifyHarness,
  ScriptedRouter,
  baseConfig,
  handlersFor,
  recorder,
  resetWorld,
  resolutionRow,
  setSetting,
  startRuntime,
  storeResolution,
  type ModelProbeSeam,
  type WorkerRuntimeLike,
} from './support/m8b-t5-world.js';

/**
 * JEV-2-B W9 (contract point 10), the r5 completion-fence pattern: while the setting is the alias,
 * a changed stored resolution changes the restart fingerprint, so a classification job that was in
 * flight is discarded with `StaleWorkerError` and writes nothing. While the setting is concrete the
 * resolution row is irrelevant to the process, and an unchanged row never fences.
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

/** A production runtime on the given setting; the probe must never be needed (a row is stored). */
async function boot(setting: string | null) {
  await storeResolution(h.owner, OLD_MODEL);
  if (setting !== null) await setSetting(h.owner, 'engine.typesafe_model', setting);
  const modelProbe = vi.fn<ModelProbeSeam>(async () => {
    throw new Error('the probe must not run: a resolution is stored');
  });
  const runtime = await startRuntime({
    db: h.db,
    config: baseConfig('production'),
    recorder: recorder(),
    selfRestart: false,
    modelProbe,
  });
  runtimes.push(runtime);
  // The alias must really be in effect, or the controls would pass for the wrong reason.
  expect(runtime.modelState).toMatchObject(
    setting === 'jev-latest'
      ? { kind: 'resolved', alias: 'jev-latest', model: OLD_MODEL, source: 'stored' }
      : { kind: 'concrete' },
  );
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
    (e: unknown) => e as { name?: string; retryDelaySeconds?: number; reason?: string },
  );
  return { articleId, router, error };
}

const changeResolution = () =>
  setSetting(h.owner, 'engine.model_resolution', {
    alias: 'jev-latest',
    model: NEW_MODEL,
    resolvedAt: '2026-10-20T09:00:00.000Z',
    checkedAt: '2026-10-20T09:00:00.000Z',
    previous: { model: OLD_MODEL, until: '2026-10-20T09:00:00.000Z' },
  });

describe('W9: the stored resolution fences classification while the setting is the alias', () => {
  it('discards the answer and writes nothing when the resolution changed in flight', async () => {
    const runtime = await boot('jev-latest');
    expect(runtime.modelState).toMatchObject({ kind: 'resolved', model: OLD_MODEL });
    const { articleId, router, error } = await enrichWhileChanging(
      runtime,
      'w9-a',
      changeResolution,
    );
    expect(router.asksFor(articleId)).toHaveLength(1);
    expect(error).toMatchObject({ name: 'StaleWorkerError', retryDelaySeconds: 30 });
    expect(await h.facetRow(articleId)).toBeNull();
    expect((await h.articleRow(articleId)).state).toBe('extracted');
    expect((await resolutionRow(h.owner))?.model).toBe(NEW_MODEL);
  });

  it('control: the same change while the setting is concrete is not stale', async () => {
    const runtime = await boot(null);
    expect(runtime.modelState).toMatchObject({ kind: 'concrete', model: OLD_MODEL });
    const { articleId, error } = await enrichWhileChanging(runtime, 'w9-b', changeResolution);
    expect(error).toBeUndefined();
    expect(await h.facetRow(articleId)).not.toBeNull();
    expect((await h.articleRow(articleId)).state).toBe('enriched');
  });

  it('control 2: an unchanged resolution row is not stale', async () => {
    const runtime = await boot('jev-latest');
    const { articleId, error } = await enrichWhileChanging(runtime, 'w9-c', async () => {});
    expect(error).toBeUndefined();
    expect(await h.facetRow(articleId)).not.toBeNull();
    expect((await h.articleRow(articleId)).state).toBe('enriched');
  });

  it('control 3: a rewrite of the same model (only checkedAt moves) is not stale', async () => {
    const runtime = await boot('jev-latest');
    const { articleId, error } = await enrichWhileChanging(runtime, 'w9-d', () =>
      storeResolution(h.owner, OLD_MODEL, '2026-10-20T09:30:00.000Z').then(() => undefined),
    );
    expect(error).toBeUndefined();
    expect(await h.facetRow(articleId)).not.toBeNull();
  });
});
