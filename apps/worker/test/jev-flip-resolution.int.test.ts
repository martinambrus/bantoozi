import { startFakeTypeSafe, type FakeTypeSafeServer } from '@bantoozi/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as resolution from '../src/model-resolution.js';

import {
  NEW_MODEL,
  OLD_MODEL,
  ClassifyHarness,
  baseConfig,
  pinRow,
  rebuildIntents,
  recorder,
  resetWorld,
  resolutionRow,
  setSetting,
  startRuntime,
  storeResolution,
  type ModelProbeResultLike,
  type ModelProbeSeam,
  type Recorder,
  type StartOptions,
  type WorkerRuntimeLike,
} from './support/m8b-t5-world.js';
import {
  V113,
  WatchMailer,
  addAdmin,
  clearAdmins,
  fakeTable,
  rawSetting,
  realProber,
  runWatch,
  watchRow,
} from './support/model-watch-world.js';

/**
 * A restarting worker must not pin a dormant `jev-latest` resolution: it asks Jev first, pins what
 * Jev answers now, and start and retry never write a flip (T2 of FNF[jev-flip-safety]).
 */
const ALIAS = 'jev-latest';
const T0 = new Date('2026-10-20T10:00:00.000Z');
const MIN = 60_000;
const API_KEY = 'jev-flip-resolution-key-01';
const DORMANT_MODEL = 'jev-1.12.0';
const OLD_ROW_AT = '2026-10-10T08:00:00.000Z';

let h: ClassifyHarness;
let fake: FakeTypeSafeServer;
const runtimes: WorkerRuntimeLike[] = [];

beforeAll(async () => {
  h = await ClassifyHarness.start();
  fake = await startFakeTypeSafe({ apiKey: API_KEY, models: fakeTable(NEW_MODEL) });
}, 240_000);

afterAll(async () => {
  for (const runtime of runtimes) await runtime.close().catch(() => undefined);
  await fake?.close();
  await h?.close();
});

beforeEach(async () => {
  await resetWorld(h);
  await h.owner.query(`DELETE FROM settings WHERE key = ANY($1::text[])`, [
    ['engine.model_watch', 'engine.rating_fingerprints', 'house.progress'],
  ]);
  fake.setOptions({ apiKey: API_KEY, models: fakeTable(NEW_MODEL) });
  fake.requests.splice(0);
});

const okProbe = (model = OLD_MODEL): ModelProbeResultLike => ({
  requested: ALIAS,
  answered: model,
  ok: true,
  at: T0.toISOString(),
});
const failedProbe = (): ModelProbeResultLike => ({
  requested: ALIAS,
  ok: false,
  at: T0.toISOString(),
  error: 'timeout',
});
function spy(...results: ModelProbeResultLike[]) {
  let i = 0;
  return vi.fn<ModelProbeSeam>(async () => results[Math.min(i++, results.length - 1)]!);
}
const throwing = () =>
  vi.fn<ModelProbeSeam>(async () => {
    throw new Error('the probe must not run');
  });

async function boot(
  nodeEnv: 'test' | 'production',
  options: Partial<Omit<StartOptions, 'db' | 'config' | 'recorder'>> & {
    rec?: Recorder;
    config?: Parameters<typeof baseConfig>[1];
  } = {},
) {
  const { rec = recorder(), config, ...rest } = options;
  const runtime = await startRuntime({
    db: h.db,
    config: baseConfig(nodeEnv, config),
    recorder: rec,
    ...rest,
  });
  runtimes.push(runtime);
  return { runtime, rec };
}

const useAlias = () => setSetting(h.owner, 'engine.typesafe_model', ALIAS);
const dropPin = () => h.owner.query(`DELETE FROM settings WHERE key = 'engine.model_pin'`);
const clock = () => {
  const state = { t: T0.getTime() };
  return { now: () => new Date(state.t), advance: (ms: number) => void (state.t += ms) };
};
const requestedModels = () => fake.requests.map((r) => (r.body as { model: string }).model);
const rowAt = (model: string, at: string) => storeResolution(h.owner, model, at);

describe('N2: the dormant row is not adopted; Jev is asked first', () => {
  it('pins what Jev answers now: one probe, one rebuild pair, no flip notice, no mail', async () => {
    await resetWorld(h, { model: V113 });
    await rowAt(DORMANT_MODEL, OLD_ROW_AT);
    await useAlias();
    const { runtime } = await boot('test', {
      now: () => T0,
      config: { typesafeBaseUrl: fake.url, typesafeApiKey: API_KEY },
    });
    expect(requestedModels()[0]).toBe(ALIAS);
    expect(requestedModels().filter((m) => m === ALIAS)).toHaveLength(1);
    expect(runtime.modelState).toEqual({
      kind: 'resolved',
      alias: ALIAS,
      model: NEW_MODEL,
      source: 'probed',
    });
    expect(await pinRow(h.owner)).toEqual({
      model: NEW_MODEL,
      alias: ALIAS,
      since: T0.toISOString(),
    });
    expect((await rebuildIntents(h.owner)).map((i) => i.queue)).toEqual([
      'house.reenrich',
      'house.rematch',
    ]);
    const stored = await resolutionRow(h.owner);
    expect(stored).toEqual({
      alias: ALIAS,
      model: NEW_MODEL,
      resolvedAt: T0.toISOString(),
      checkedAt: T0.toISOString(),
    });
    expect((await watchRow(h.owner)).notice).toBeUndefined();

    await clearAdmins(h.owner);
    await addAdmin(h.owner, 'n2-admin@example.test');
    const mailer = new WatchMailer();
    await runWatch(h, { prober: realProber(h, fake, T0), mailer, now: T0 });
    expect(mailer.attempts).toBe(0);
    expect(await rebuildIntents(h.owner)).toHaveLength(2);
    expect((await watchRow(h.owner)).notice).toBeUndefined();
  });

  it('variant: Jev still answers the pinned release, so the pin only gains the alias', async () => {
    fake.setOptions({ models: fakeTable(V113) });
    await resetWorld(h, { model: V113 });
    await rowAt(DORMANT_MODEL, OLD_ROW_AT);
    await useAlias();
    const { runtime } = await boot('test', {
      now: () => T0,
      config: { typesafeBaseUrl: fake.url, typesafeApiKey: API_KEY },
    });
    expect(runtime.modelState).toMatchObject({ kind: 'resolved', model: V113, source: 'probed' });
    expect(await pinRow(h.owner)).toEqual({
      model: V113,
      alias: ALIAS,
      since: '2026-10-01T00:00:00.000Z',
    });
    expect(await rebuildIntents(h.owner)).toEqual([]);
  });
});

describe('N3: a resolution in force is used without a probe', () => {
  const cases: [string, () => Promise<void>][] = [
    [
      'alias-marked pin and an old row of another model (flip in flight)',
      async () => {
        await setSetting(h.owner, 'engine.model_pin', {
          model: OLD_MODEL,
          alias: ALIAS,
          since: '2026-10-01T00:00:00.000Z',
        });
        await rowAt(NEW_MODEL, OLD_ROW_AT);
      },
    ],
    [
      'no pin and an old row',
      async () => {
        await dropPin();
        await rowAt(NEW_MODEL, OLD_ROW_AT);
      },
    ],
    [
      'an unmarked pin and an old row equal to the pin',
      () => rowAt(OLD_MODEL, OLD_ROW_AT).then(() => undefined),
    ],
    [
      'an unmarked pin and a row of another model confirmed 2 minutes ago',
      () => rowAt(NEW_MODEL, new Date(T0.getTime() - 2 * MIN).toISOString()).then(() => undefined),
    ],
  ];

  it.each(cases)('%s', async (_name, arrange) => {
    await arrange();
    await useAlias();
    const stored = await resolutionRow(h.owner);
    const probe = throwing();
    const { runtime } = await boot('production', { modelProbe: probe, now: () => T0 });
    expect(probe).not.toHaveBeenCalled();
    expect(runtime.modelState).toEqual({
      kind: 'resolved',
      alias: ALIAS,
      model: stored!.model,
      source: 'stored',
    });
    expect(await resolutionRow(h.owner)).toEqual(stored);
  });
});

describe('N4: an unresolved start that resolves on retry asks for a restart once and stops probing', () => {
  it('probes twice at most, stays pending, and warns once', async () => {
    await useAlias();
    await dropPin();
    const time = clock();
    const probe = spy(failedProbe(), okProbe(OLD_MODEL));
    const { runtime, rec } = await boot('production', {
      modelProbe: probe,
      now: time.now,
      selfRestart: false,
      resolveRetryMs: 5 * MIN,
    });
    time.advance(5 * MIN);
    expect(await runtime.check()).toEqual({ pendingRestart: true, exiting: false });
    expect(probe).toHaveBeenCalledTimes(2);
    time.advance(60 * MIN);
    for (let i = 0; i < 3; i += 1) {
      expect(await runtime.check()).toEqual({ pendingRestart: true, exiting: false });
    }
    expect(probe).toHaveBeenCalledTimes(2);
    const warns = rec.logs.filter((e) => e.level === 'warn' && e.obj['pendingRestart'] === true);
    expect(warns).toHaveLength(1);
    expect(warns[0]!.msg).toMatch(/resolved/);
    expect(rec.exits).toEqual([]);
  });
});

describe('N5: start and retry never overwrite a resolution in force', () => {
  it('a: a row that appears while the start probe runs is adopted untouched', async () => {
    await dropPin();
    await useAlias();
    const probe = vi.fn<ModelProbeSeam>(async () => {
      await storeResolution(h.owner, OLD_MODEL, T0.toISOString());
      return okProbe(NEW_MODEL);
    });
    const { runtime } = await boot('production', { modelProbe: probe, now: () => T0 });
    const before = await rawSetting(h.owner, 'engine.model_resolution');
    expect(runtime.processModel).toBe(OLD_MODEL);
    expect(runtime.modelState).toMatchObject({ kind: 'resolved', model: OLD_MODEL });
    expect(await pinRow(h.owner)).toMatchObject({ model: OLD_MODEL, alias: ALIAS });
    expect(await runtime.check()).toEqual({ pendingRestart: false, exiting: false });
    expect(await rawSetting(h.owner, 'engine.model_resolution')).toEqual(before);
    expect(JSON.parse(before!.text)).not.toHaveProperty('previous');
  });

  it('b: a row that appears while unresolved is awaited, not probed over', async () => {
    await dropPin();
    await useAlias();
    const time = clock();
    const probe = spy(failedProbe(), okProbe(NEW_MODEL));
    const { runtime, rec } = await boot('production', {
      modelProbe: probe,
      now: time.now,
      selfRestart: false,
      resolveRetryMs: 5 * MIN,
    });
    await storeResolution(h.owner, OLD_MODEL, time.now().toISOString());
    const before = await rawSetting(h.owner, 'engine.model_resolution');
    time.advance(5 * MIN);
    expect(await runtime.check()).toEqual({ pendingRestart: true, exiting: false });
    time.advance(60 * MIN);
    expect(await runtime.check()).toEqual({ pendingRestart: true, exiting: false });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(await rawSetting(h.owner, 'engine.model_resolution')).toEqual(before);
    expect((await watchRow(h.owner)).notice).toBeUndefined();
    expect(rec.exits).toEqual([]);
  });
});

describe('N6: a dormant row and a failing probe', () => {
  it('stays unresolved without a restart loop; the retry replaces the row and restarts once', async () => {
    await rowAt(DORMANT_MODEL, OLD_ROW_AT);
    await useAlias();
    const dormant = await rawSetting(h.owner, 'engine.model_resolution');
    const time = clock();
    const probe = spy(failedProbe(), okProbe(DORMANT_MODEL));
    const { runtime, rec } = await boot('production', {
      modelProbe: probe,
      now: time.now,
      selfRestart: true,
      resolveRetryMs: 5 * MIN,
    });
    expect(runtime.modelState).toMatchObject({ kind: 'unresolved', alias: ALIAS });
    expect(await runtime.check()).toEqual({ pendingRestart: false, exiting: false });
    expect(await rawSetting(h.owner, 'engine.model_resolution')).toEqual(dormant);

    time.advance(5 * MIN);
    expect(await runtime.check()).toEqual({ pendingRestart: true, exiting: true });
    const replaced = await resolutionRow(h.owner);
    expect(replaced).toEqual({
      alias: ALIAS,
      model: DORMANT_MODEL,
      resolvedAt: time.now().toISOString(),
      checkedAt: time.now().toISOString(),
    });
    expect(rec.calls).toEqual(['drain', 'exit']);
    time.advance(MIN);
    await runtime.check();
    expect(rec.exits).toEqual([0]);

    const next = throwing();
    const second = await boot('production', { modelProbe: next, now: time.now });
    expect(next).not.toHaveBeenCalled();
    expect(second.runtime.modelState).toMatchObject({
      kind: 'resolved',
      model: DORMANT_MODEL,
      source: 'stored',
    });
    expect(await second.runtime.check()).toEqual({ pendingRestart: false, exiting: false });
  });
});

describe('N7: recordStartResolution', () => {
  const input = (dormant?: unknown) => ({
    alias: ALIAS,
    model: NEW_MODEL,
    now: T0,
    ...(dormant === undefined ? {} : { dormant: dormant as never }),
  });
  const fresh = {
    alias: ALIAS,
    model: NEW_MODEL,
    resolvedAt: T0.toISOString(),
    checkedAt: T0.toISOString(),
  };

  beforeEach(async () => {
    await h.owner.query(`DELETE FROM settings WHERE key = 'engine.model_resolution'`);
  });

  it('creates an absent row', async () => {
    expect(await resolution.recordStartResolution(h.db, input())).toEqual(fresh);
    expect(await resolutionRow(h.owner)).toEqual(fresh);
  });

  it('replaces an invalid row', async () => {
    await setSetting(h.owner, 'engine.model_resolution', { nonsense: true });
    expect(await resolution.recordStartResolution(h.db, input())).toEqual(fresh);
    expect(await resolutionRow(h.owner)).toEqual(fresh);
  });

  it('adopts a valid row byte-identical', async () => {
    const row = await storeResolution(h.owner, OLD_MODEL, T0.toISOString());
    const before = await rawSetting(h.owner, 'engine.model_resolution');
    expect(await resolution.recordStartResolution(h.db, input())).toEqual(row);
    expect(await rawSetting(h.owner, 'engine.model_resolution')).toEqual(before);
  });

  it('replaces a row identical to the dormant one, without previous', async () => {
    const dormant = await storeResolution(h.owner, DORMANT_MODEL, OLD_ROW_AT);
    expect(await resolution.recordStartResolution(h.db, input(dormant))).toEqual(fresh);
    expect(await resolutionRow(h.owner)).toEqual(fresh);
  });

  it('adopts a row that differs from the dormant one', async () => {
    const dormant = await storeResolution(h.owner, DORMANT_MODEL, OLD_ROW_AT);
    const other = await storeResolution(h.owner, OLD_MODEL, '2026-10-19T00:00:00.000Z');
    expect(await resolution.recordStartResolution(h.db, input(dormant))).toEqual(other);
    expect(await resolutionRow(h.owner)).toEqual(other);
  });
});

describe('N8: no restart loop right after boot', () => {
  const settings = ['concrete', 'alias'] as const;
  const rows = ['none', 'in force', 'dormant'] as const;
  const pins = ['none', 'unmarked', 'marked'] as const;
  const probes = ['same', 'other', 'fail'] as const;
  const matrix = settings.flatMap((s) =>
    rows.flatMap((r) => pins.flatMap((p) => probes.map((q) => [s, r, p, q] as const))),
  );

  it.each(matrix)('setting %s, row %s, pin %s, probe %s', async (setting, row, pin, answer) => {
    await resetWorld(h);
    if (pin === 'none') await dropPin();
    if (pin === 'marked') {
      await setSetting(h.owner, 'engine.model_pin', {
        model: OLD_MODEL,
        alias: ALIAS,
        since: '2026-10-01T00:00:00.000Z',
      });
    }
    if (row === 'in force') await rowAt(NEW_MODEL, T0.toISOString());
    if (row === 'dormant') await rowAt(DORMANT_MODEL, OLD_ROW_AT);
    if (setting === 'alias') await useAlias();
    const probe = spy(
      answer === 'fail' ? failedProbe() : okProbe(answer === 'same' ? OLD_MODEL : NEW_MODEL),
    );
    const { runtime, rec } = await boot('production', {
      modelProbe: probe,
      now: () => T0,
      selfRestart: true,
      resolveRetryMs: 5 * MIN,
    });
    expect(await runtime.check()).toEqual({ pendingRestart: false, exiting: false });
    expect(rec.exits).toEqual([]);
  });
});
