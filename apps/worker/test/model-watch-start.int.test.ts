import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClassifyHarness } from './support/classify.js';
import {
  OLD_MODEL,
  baseConfig,
  recorder,
  resetWorld,
  setSetting,
  startRuntime,
  storeResolution,
  type ModelProbeSeam,
  type WorkerRuntimeLike,
} from './support/m8b-t5-world.js';
import { ALIAS, NOW, enqueueWatchNow, iso, watchIntents } from './support/model-watch-world.js';

/**
 * JEV-3 U1 (harness brief S1..S4): a worker that starts on a stored resolution of `jev-latest` asks
 * for one watch run (`enqueueModelWatchNow`, one outbox intent that coalesces while pending). Any
 * other start (concrete setting, unresolved alias, start probe, `recordPin: false`) asks for none.
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

const refusing = (): ModelProbeSeam =>
  vi.fn<ModelProbeSeam>(async () => {
    throw new Error('the probe is not available');
  });

const answering = (): ModelProbeSeam =>
  vi.fn<ModelProbeSeam>(async () => ({
    requested: ALIAS,
    answered: OLD_MODEL,
    ok: true,
    at: iso(NOW),
  }));

async function boot(
  options: {
    nodeEnv?: 'test' | 'production';
    modelProbe?: ModelProbeSeam;
    recordPin?: boolean;
  } = {},
): Promise<WorkerRuntimeLike> {
  const runtime = await startRuntime({
    db: h.db,
    config: baseConfig(options.nodeEnv ?? 'production'),
    recorder: recorder(),
    modelProbe: options.modelProbe ?? refusing(),
    ...(options.recordPin === undefined ? {} : { recordPin: options.recordPin }),
  });
  runtimes.push(runtime);
  return runtime;
}

async function useAlias(stored: boolean): Promise<void> {
  await setSetting(h.owner, 'engine.typesafe_model', ALIAS);
  if (stored) await storeResolution(h.owner, OLD_MODEL);
}

describe('S1: a worker started on a stored resolution of the alias', () => {
  it('leaves exactly one pending house.model-watch intent with the empty payload', async () => {
    await useAlias(true);
    const runtime = await boot();
    expect(runtime.modelState).toMatchObject({ kind: 'resolved', source: 'stored' });
    expect(await watchIntents(h.owner)).toEqual([
      expect.objectContaining({ queue: 'house.model-watch', payload: {} }),
    ]);
  });

  it('does so outside production too', async () => {
    await useAlias(true);
    await boot({ nodeEnv: 'test' });
    expect(await watchIntents(h.owner)).toHaveLength(1);
  });
});

describe('S2: starts that ask for no watch run', () => {
  it('a concrete model setting', async () => {
    const runtime = await boot({ nodeEnv: 'test' });
    expect(runtime.modelState).toMatchObject({ kind: 'concrete' });
    expect(await watchIntents(h.owner)).toEqual([]);
  });

  it('a concrete model setting stored in the database, with a resolution row left over', async () => {
    await setSetting(h.owner, 'engine.typesafe_model', OLD_MODEL);
    await storeResolution(h.owner, OLD_MODEL);
    const runtime = await boot();
    expect(runtime.modelState).toMatchObject({ kind: 'concrete' });
    expect(await watchIntents(h.owner)).toEqual([]);
  });

  it('an unresolved alias (no stored resolution, the start probe fails)', async () => {
    await useAlias(false);
    const runtime = await boot({ modelProbe: refusing() });
    expect(runtime.modelState).toMatchObject({ kind: 'unresolved' });
    expect(await watchIntents(h.owner)).toEqual([]);
  });

  it('a resolution made by the start probe (source probed)', async () => {
    await useAlias(false);
    const modelProbe = answering();
    const runtime = await boot({ modelProbe });
    expect(runtime.modelState).toMatchObject({ kind: 'resolved', source: 'probed' });
    expect(modelProbe).toHaveBeenCalledTimes(1);
    expect(await watchIntents(h.owner)).toEqual([]);
  });

  it('recordPin false (eval ingest-only), even with a stored resolution', async () => {
    await useAlias(true);
    const runtime = await boot({ recordPin: false });
    expect(runtime.modelState).toMatchObject({ kind: 'resolved', source: 'stored' });
    expect(await watchIntents(h.owner)).toEqual([]);
  });
});

describe('S3: two workers starting together', () => {
  it('coalesce into one pending intent; a start after delivery asks again', async () => {
    await useAlias(true);
    await boot();
    await boot();
    expect(await watchIntents(h.owner)).toHaveLength(1);

    await h.clearOutbox();
    expect(await watchIntents(h.owner)).toEqual([]);
    await boot();
    expect(await watchIntents(h.owner)).toHaveLength(1);
    await boot();
    expect(await watchIntents(h.owner)).toHaveLength(1);
  });
});

describe('S4: enqueueModelWatchNow', () => {
  it('writes one pending intent however often it is called while that intent is pending', async () => {
    await enqueueWatchNow(h.db);
    await enqueueWatchNow(h.db);
    const pending = await watchIntents(h.owner);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ queue: 'house.model-watch', payload: {} });
  });

  it('asks again once the pending intent was delivered', async () => {
    await enqueueWatchNow(h.db);
    await h.clearOutbox();
    await enqueueWatchNow(h.db);
    expect(await watchIntents(h.owner)).toHaveLength(1);
  });
});
