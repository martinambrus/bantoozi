import { readRatingFingerprint } from '@bantoozi/db';
import type { EngineRequest, EngineRouter, Question } from '@bantoozi/engine';
import type { InferenceAuthorization } from '@bantoozi/shared';
import { startFakeTypeSafe, type FakeTypeSafeServer } from '@bantoozi/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { primaryAvailability } from '../src/classify/availability.js';
import { dispatch } from '../src/handlers/index.js';

import {
  NEW_MODEL,
  OLD_MODEL,
  ClassifyHarness,
  baseConfig,
  expectedDedupeKey,
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

/**
 * JEV-2-B: `jev-latest` at worker start (contract points 4, 6, 7, 10). The alias is resolved to a
 * concrete Jev release once (a stored resolution, else one probe), the concrete id is what the
 * router lane, `classification.primaryModel`, `processModel` and the pin use, and a runtime that
 * cannot resolve stays up with no Jev lane and retries. Production runtimes inject `modelProbe`
 * (the production engine needs https); W14 runs the real prober against the fake TypeSafe server.
 * Seams: `support/m8b-t5-world.ts` (header).
 */
const ALIAS = 'jev-latest';
const T0 = new Date('2026-10-20T10:00:00.000Z');
const MIN = 60_000;
const API_KEY = 'jev-alias-start-key-0001';

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

const okProbe = (model = OLD_MODEL): ModelProbeResultLike => ({
  requested: ALIAS,
  answered: model,
  ok: true,
  at: T0.toISOString(),
});
const failedProbe = (error = 'timeout'): ModelProbeResultLike => ({
  requested: ALIAS,
  ok: false,
  at: T0.toISOString(),
  error,
});

/** A probe seam that answers `results` in order (the last one repeats) and records its calls. */
function spy(...results: ModelProbeResultLike[]) {
  let i = 0;
  return vi.fn<ModelProbeSeam>(async () => results[Math.min(i++, results.length - 1)]!);
}

interface Boot {
  runtime: WorkerRuntimeLike;
  rec: Recorder;
}

async function boot(
  nodeEnv: 'test' | 'production',
  options: Partial<Omit<StartOptions, 'db' | 'config' | 'recorder'>> & {
    rec?: Recorder;
    config?: Parameters<typeof baseConfig>[1];
  } = {},
): Promise<Boot> {
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

async function lane(runtime: WorkerRuntimeLike): Promise<unknown> {
  const status = (await runtime.models.classification.router.status()) as { typesafeLane?: string };
  return status.typesafeLane;
}

/** An extracted article with a live reader, as an engine request with its authorization. */
async function articleRequest(): Promise<EngineRequest> {
  const feedId = await h.feed();
  const userId = await h.user();
  await h.subscribe(userId, feedId, 'active');
  const articleId = await h.article({ feedIds: [feedId] });
  const revision = (await h.articleRow(articleId)).revision;
  const authorization: InferenceAuthorization = {
    type: 'article',
    articleId,
    articleRevision: revision,
    witnesses: [{ kind: 'automatic', userId, feedId, inferenceVersion: '1' }],
  };
  const questions: Record<string, Question> = {
    topic: {
      type: 'choice',
      instructions: 'Main topic',
      criteria: { energy: 'Energy and power grids', sport: 'Sport' },
    },
  };
  return {
    kind: 'enrich',
    state: { article: { title: 'Grid storage report', excerpt: 'Batteries and solar farms.' } },
    questions,
    questionSetSha: 'a'.repeat(64),
    stateSha256: 'b'.repeat(64),
    articleId,
    articleRevision: revision,
    priority: 'bulk',
    authorization,
  };
}

describe('W3: the alias with a stored resolution', () => {
  it('resolves from the row without a probe and uses 1.13.0 everywhere; the pin records the alias', async () => {
    await storeResolution(h.owner, OLD_MODEL);
    await useAlias();
    await dropPin();
    const probe = spy(okProbe(NEW_MODEL));
    const { runtime } = await boot('production', { modelProbe: probe, now: () => T0 });

    expect(probe).not.toHaveBeenCalled();
    expect(runtime.modelState).toEqual({
      kind: 'resolved',
      alias: ALIAS,
      model: OLD_MODEL,
      source: 'stored',
    });
    expect(runtime.processModel).toBe(OLD_MODEL);
    expect(runtime.models.classification.primaryModel).toBe(OLD_MODEL);
    expect(await lane(runtime)).toBe('ready');
    expect(runtime.values.typesafeModel).toBe(ALIAS);
    expect(await pinRow(h.owner)).toEqual({
      model: OLD_MODEL,
      alias: ALIAS,
      since: T0.toISOString(),
    });
    expect(await rebuildIntents(h.owner)).toEqual([]);
    // The stored row is read, not rewritten.
    expect((await resolutionRow(h.owner))?.checkedAt).toBe('2026-10-10T08:00:00.000Z');
  });

  it('control: a concrete setting is concrete, with no alias in the pin and no probe', async () => {
    await storeResolution(h.owner, NEW_MODEL);
    await dropPin();
    const probe = spy(okProbe(NEW_MODEL));
    const { runtime } = await boot('production', { modelProbe: probe, now: () => T0 });
    expect(probe).not.toHaveBeenCalled();
    expect(runtime.modelState).toEqual({ kind: 'concrete', model: OLD_MODEL });
    expect(runtime.processModel).toBe(OLD_MODEL);
    const pin = await pinRow(h.owner);
    expect(pin).toMatchObject({ model: OLD_MODEL });
    expect(pin).not.toHaveProperty('alias');
  });

  it('control: another stored resolution (1.14.0) gives another model everywhere', async () => {
    await storeResolution(h.owner, NEW_MODEL);
    await useAlias();
    const { runtime } = await boot('production', { modelProbe: spy(okProbe()), now: () => T0 });
    expect(runtime.processModel).toBe(NEW_MODEL);
    expect(runtime.models.classification.primaryModel).toBe(NEW_MODEL);
    expect(runtime.modelState).toMatchObject({ kind: 'resolved', model: NEW_MODEL });
  });
});

describe('W4: the alias without a stored resolution, the probe resolves it', () => {
  it('probes once, writes the resolution and the pin, and never asks for a restart', async () => {
    await useAlias();
    await dropPin();
    const probe = spy(okProbe(OLD_MODEL));
    const { runtime, rec } = await boot('production', {
      modelProbe: probe,
      selfRestart: true,
      now: () => T0,
    });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(ALIAS, expect.any(AbortSignal));
    const row = await resolutionRow(h.owner);
    expect(row).toMatchObject({ alias: ALIAS, model: OLD_MODEL });
    expect(Number.isNaN(Date.parse(row!.resolvedAt))).toBe(false);
    expect(Number.isNaN(Date.parse(row!.checkedAt))).toBe(false);
    expect(row!.resolvedAt).toBe(new Date(row!.resolvedAt).toISOString());
    expect(runtime.modelState).toEqual({
      kind: 'resolved',
      alias: ALIAS,
      model: OLD_MODEL,
      source: 'probed',
    });
    expect(await pinRow(h.owner)).toMatchObject({ model: OLD_MODEL, alias: ALIAS });
    expect(runtime.processModel).toBe(OLD_MODEL);
    expect(await lane(runtime)).toBe('ready');
    for (let i = 0; i < 3; i += 1) {
      expect(await runtime.check()).toEqual({ pendingRestart: false, exiting: false });
    }
    expect(rec.exits).toEqual([]);
    expect(rec.drains).toBe(0);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('control: the probe answers 1.14.0, so the row, the model and the pin say 1.14.0', async () => {
    await useAlias();
    await dropPin();
    const { runtime } = await boot('production', { modelProbe: spy(okProbe(NEW_MODEL)) });
    expect((await resolutionRow(h.owner))?.model).toBe(NEW_MODEL);
    expect(runtime.processModel).toBe(NEW_MODEL);
    expect(runtime.models.classification.primaryModel).toBe(NEW_MODEL);
    expect(await pinRow(h.owner)).toMatchObject({ model: NEW_MODEL, alias: ALIAS });
  });
});

describe('W5: the alias without a stored resolution, the probe is unavailable', () => {
  const cases: [string, () => { probe: ModelProbeSeam; extra: { resolveTimeoutMs?: number } }][] = [
    ['the probe reports a timeout', () => ({ probe: spy(failedProbe('timeout')), extra: {} })],
    [
      'the probe never resolves (resolveTimeoutMs 50)',
      () => ({
        probe: vi.fn<ModelProbeSeam>(() => new Promise<ModelProbeResultLike>(() => {})),
        extra: { resolveTimeoutMs: 50 },
      }),
    ],
  ];

  it.each(cases)(
    '%s: the runtime starts unresolved with no pin and no resolution',
    async (_n, make) => {
      await useAlias();
      await dropPin();
      const { probe, extra } = make();
      const { runtime } = await boot('production', {
        modelProbe: probe,
        now: () => T0,
        config: { typesafeApiKey: 'present-but-unused-key-01' },
        ...extra,
      });
      expect(probe).toHaveBeenCalledTimes(1);
      expect(runtime.modelState).toMatchObject({ kind: 'unresolved', alias: ALIAS });
      expect(await pinRow(h.owner)).toBeUndefined();
      expect(await resolutionRow(h.owner)).toBeUndefined();
      expect(runtime.processModel).toBe(ALIAS);
      expect(runtime.models.classification.primaryModel).toBe(ALIAS);
      const problems = runtime
        .heartbeatRuntime()
        .problems.filter((p) => p.key === 'engine.typesafe_model');
      expect(problems).toHaveLength(1);
      expect(problems[0]!.message).toContain(ALIAS);
      expect(await lane(runtime)).toBe('unconfigured');

      // No Jev lane: the router answers without a request and the primary is reported unconfigured.
      const router = runtime.models.classification.router as EngineRouter;
      const outcome = await router.ask(await articleRequest());
      expect(outcome).toMatchObject({ ok: false, reason: 'no_key' });
      expect(await primaryAvailability(h.db, router, h.settingsEnv, T0)).toEqual({
        available: false,
        reason: 'unconfigured',
      });
    },
  );

  it('an unavailable probe leaves an existing pin and the process model untouched', async () => {
    await useAlias();
    const before = await pinRow(h.owner);
    expect(before).toMatchObject({ model: OLD_MODEL });
    const { runtime } = await boot('production', { modelProbe: spy(failedProbe()), now: () => T0 });
    expect(runtime.modelState).toMatchObject({ kind: 'unresolved' });
    expect(runtime.processModel).toBe(OLD_MODEL);
    expect(runtime.models.classification.primaryModel).toBe(OLD_MODEL);
    expect(await pinRow(h.owner)).toEqual(before);
    expect(await resolutionRow(h.owner)).toBeUndefined();
    expect(runtime.heartbeatRuntime().problems.map((p) => p.key)).toContain(
      'engine.typesafe_model',
    );
    expect(await lane(runtime)).toBe('unconfigured');
    expect(await rebuildIntents(h.owner)).toEqual([]);
  });

  it('the start probe is aborted at the deadline', async () => {
    await useAlias();
    let seen: AbortSignal | undefined;
    const probe = vi.fn<ModelProbeSeam>((_r, signal) => {
      seen = signal;
      return new Promise<ModelProbeResultLike>(() => {});
    });
    await boot('production', { modelProbe: probe, resolveTimeoutMs: 50 });
    expect(seen?.aborted).toBe(true);
  });

  it('control: a successful probe is never reported as a problem and has a lane', async () => {
    await useAlias();
    const { runtime } = await boot('production', { modelProbe: spy(okProbe()) });
    expect(runtime.heartbeatRuntime().problems.map((p) => p.key)).not.toContain(
      'engine.typesafe_model',
    );
    expect(await lane(runtime)).toBe('ready');
  });
});

describe('W6: the retry of an unresolved runtime', () => {
  it('probes again after resolveRetryMs, writes only the resolution, and asks for the restart once', async () => {
    await useAlias();
    await dropPin();
    const time = clock();
    const probe = spy(failedProbe(), okProbe(OLD_MODEL));
    const { runtime, rec } = await boot('production', {
      modelProbe: probe,
      now: time.now,
      selfRestart: true,
      resolveRetryMs: 5 * MIN,
    });
    expect(probe).toHaveBeenCalledTimes(1);

    time.advance(4 * MIN);
    expect(await runtime.check()).toEqual({ pendingRestart: false, exiting: false });
    expect(probe).toHaveBeenCalledTimes(1);

    time.advance(1 * MIN);
    expect(await runtime.check()).toEqual({ pendingRestart: true, exiting: true });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenLastCalledWith(ALIAS, expect.any(AbortSignal));
    expect(await resolutionRow(h.owner)).toMatchObject({ alias: ALIAS, model: OLD_MODEL });
    expect(rec.calls).toEqual(['drain', 'exit']);
    expect(rec.exits).toEqual([0]);
    // The retry only wrote the resolution: the new process records the pin.
    expect(await pinRow(h.owner)).toBeUndefined();

    time.advance(10 * MIN);
    await runtime.check();
    expect(rec.exits).toEqual([0]);
    expect(rec.drains).toBe(1);
    expect(probe).toHaveBeenCalledTimes(2);

    // The restarted process resolves from the stored row: no probe, no pending restart.
    const next = spy(failedProbe());
    const second = await boot('production', { modelProbe: next, now: time.now, selfRestart: true });
    expect(next).not.toHaveBeenCalled();
    expect(second.runtime.modelState).toMatchObject({ kind: 'resolved', source: 'stored' });
    expect(await second.runtime.check()).toEqual({ pendingRestart: false, exiting: false });
    expect(second.rec.exits).toEqual([]);
  });

  it.each([
    ['outside production', 'test' as const, true],
    ['with selfRestart false', 'production' as const, false],
  ])(
    '%s: a successful retry only logs a warning, with no drain and no exit',
    async (_n, env, self) => {
      await useAlias();
      const time = clock();
      const probe = spy(failedProbe(), okProbe(OLD_MODEL));
      const { runtime, rec } = await boot(env, {
        modelProbe: probe,
        now: time.now,
        selfRestart: self,
        resolveRetryMs: 5 * MIN,
      });
      time.advance(5 * MIN);
      expect(await runtime.check()).toEqual({ pendingRestart: true, exiting: false });
      expect(probe).toHaveBeenCalledTimes(2);
      expect(rec.exits).toEqual([]);
      expect(rec.drains).toBe(0);
      expect(rec.logs.some((e) => e.level === 'warn' && e.obj['pendingRestart'] === true)).toBe(
        true,
      );
      expect(runtime.heartbeatRuntime().pendingRestart).toBe(true);
    },
  );

  it('control: a failing retry changes nothing and the next attempt waits another resolveRetryMs', async () => {
    await useAlias();
    const time = clock();
    const probe = spy(failedProbe());
    const { runtime, rec } = await boot('production', {
      modelProbe: probe,
      now: time.now,
      selfRestart: true,
      resolveRetryMs: 5 * MIN,
    });
    time.advance(5 * MIN);
    expect(await runtime.check()).toEqual({ pendingRestart: false, exiting: false });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(await resolutionRow(h.owner)).toBeUndefined();
    expect(runtime.modelState).toMatchObject({ kind: 'unresolved' });

    time.advance(4 * MIN);
    await runtime.check();
    expect(probe).toHaveBeenCalledTimes(2);
    time.advance(1 * MIN);
    await runtime.check();
    expect(probe).toHaveBeenCalledTimes(3);
    expect(rec.exits).toEqual([]);
    expect(rec.drains).toBe(0);
  });

  it('control: a resolved runtime never probes again', async () => {
    await useAlias();
    const time = clock();
    const probe = spy(okProbe());
    const { runtime } = await boot('production', {
      modelProbe: probe,
      now: time.now,
      resolveRetryMs: 5 * MIN,
    });
    time.advance(60 * MIN);
    await runtime.check();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('does not run two probes at once', async () => {
    await useAlias();
    const time = clock();
    let release: (r: ModelProbeResultLike) => void = () => {};
    let calls = 0;
    const probe = vi.fn<ModelProbeSeam>(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve(failedProbe());
      return new Promise<ModelProbeResultLike>((resolve) => {
        release = resolve;
      });
    });
    const { runtime } = await boot('production', {
      modelProbe: probe,
      now: time.now,
      selfRestart: false,
      resolveRetryMs: 5 * MIN,
    });
    time.advance(5 * MIN);
    const first = runtime.check();
    const second = runtime.check();
    await new Promise((r) => setTimeout(r, 50));
    expect(probe).toHaveBeenCalledTimes(2);
    release(okProbe());
    await Promise.all([first, second]);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

describe('W7: switching between concrete and alias does not rebuild when the model is the same', () => {
  it('adds and drops the alias in the pin in place: same since, no intents', async () => {
    await dropPin();
    const a = recorder();
    const concrete = await boot('production', { rec: a, now: () => T0 });
    expect(concrete.runtime.modelState).toMatchObject({ kind: 'concrete' });
    const first = await pinRow(h.owner);
    expect(first).toEqual({ model: OLD_MODEL, since: T0.toISOString() });
    expect(await rebuildIntents(h.owner)).toEqual([]);

    await storeResolution(h.owner, OLD_MODEL);
    await useAlias();
    const later = new Date(T0.getTime() + 60 * MIN);
    await boot('production', { modelProbe: spy(okProbe()), now: () => later });
    expect(await pinRow(h.owner)).toEqual({
      model: OLD_MODEL,
      alias: ALIAS,
      since: first!.since,
    });
    expect(await rebuildIntents(h.owner)).toEqual([]);

    await setSetting(h.owner, 'engine.typesafe_model', null);
    const evenLater = new Date(T0.getTime() + 120 * MIN);
    await boot('production', { now: () => evenLater });
    const dropped = await pinRow(h.owner);
    expect(dropped).toEqual({ model: OLD_MODEL, since: first!.since });
    expect(dropped).not.toHaveProperty('alias');
    expect(await rebuildIntents(h.owner)).toEqual([]);
  });

  it('control: an alias that resolves to another model (1.14.0) moves the pin and enqueues exactly one reenrich and one rematch', async () => {
    await dropPin();
    await boot('production', { now: () => T0 });
    await storeResolution(h.owner, NEW_MODEL);
    await useAlias();
    const later = new Date(T0.getTime() + 60 * MIN);
    await boot('production', { modelProbe: spy(okProbe()), now: () => later });
    const pin = await pinRow(h.owner);
    expect(pin).toEqual({ model: NEW_MODEL, alias: ALIAS, since: later.toISOString() });
    expect(await rebuildIntents(h.owner)).toEqual([
      {
        queue: 'house.reenrich',
        payload: {},
        dedupeKey: expectedDedupeKey('house.reenrich', later.toISOString()),
      },
      {
        queue: 'house.rematch',
        payload: {},
        dedupeKey: expectedDedupeKey('house.rematch', later.toISOString()),
      },
    ]);
  });
});

describe('W8: recordPin false never probes and never writes', () => {
  it('stays unresolved with no stored row: no probe, no pin write, no resolution write', async () => {
    await useAlias();
    const before = await pinRow(h.owner);
    const probe = spy(okProbe());
    const { runtime } = await boot('test', { modelProbe: probe, recordPin: false });
    expect(probe).not.toHaveBeenCalled();
    expect(runtime.modelState).toMatchObject({ kind: 'unresolved', alias: ALIAS });
    expect(await pinRow(h.owner)).toEqual(before);
    expect(await resolutionRow(h.owner)).toBeUndefined();
    expect(await rebuildIntents(h.owner)).toEqual([]);
    // Nor does check() probe later.
    const time = clock();
    const again = spy(okProbe());
    const second = await boot('test', {
      modelProbe: again,
      recordPin: false,
      now: time.now,
      resolveRetryMs: 5 * MIN,
    });
    time.advance(60 * MIN);
    await second.runtime.check();
    expect(again).not.toHaveBeenCalled();
  });

  it('control: with a stored row it resolves from it, still without writes', async () => {
    const row = await storeResolution(h.owner, OLD_MODEL);
    await useAlias();
    const before = await pinRow(h.owner);
    const probe = spy(okProbe(NEW_MODEL));
    const { runtime } = await boot('test', { modelProbe: probe, recordPin: false });
    expect(probe).not.toHaveBeenCalled();
    expect(runtime.modelState).toEqual({
      kind: 'resolved',
      alias: ALIAS,
      model: OLD_MODEL,
      source: 'stored',
    });
    expect(await pinRow(h.owner)).toEqual(before);
    expect(await resolutionRow(h.owner)).toEqual(row);
  });
});

describe('W14: the full flow against the fake TypeSafe server (no probe seam)', () => {
  let fake: FakeTypeSafeServer;

  beforeAll(async () => {
    fake = await startFakeTypeSafe({
      apiKey: API_KEY,
      models: { [ALIAS]: OLD_MODEL, [OLD_MODEL]: OLD_MODEL },
    });
  });
  afterAll(async () => {
    await fake?.close();
  });
  beforeEach(() => {
    fake.requests.splice(0);
  });

  const requestedModels = () => fake.requests.map((r) => (r.body as { model: string }).model);

  it('sends the alias once (the probe), then only the concrete id; the pin and the rating fingerprint use the concrete id', async () => {
    await useAlias();
    await dropPin();
    await h.owner.query('DELETE FROM engine_calls');
    const { runtime } = await boot('test', {
      now: () => T0,
      config: { typesafeBaseUrl: fake.url, typesafeApiKey: API_KEY },
    });
    expect(requestedModels()).toEqual([ALIAS]);
    expect(runtime.modelState).toMatchObject({
      kind: 'resolved',
      model: OLD_MODEL,
      source: 'probed',
    });
    expect(runtime.processModel).toBe(OLD_MODEL);

    // One router call and one real article.enrich through the handler.
    const router = runtime.models.classification.router as EngineRouter;
    const outcome = await router.ask(await articleRequest());
    expect(outcome).toMatchObject({ ok: true, model: OLD_MODEL });

    const feedId = await h.feed();
    const userId = await h.user();
    await h.subscribe(userId, feedId, 'active');
    await h.hold(userId, await h.card({ topicIds: ['technology'] }));
    const articleId = await h.article({ feedIds: [feedId] });
    await dispatch(
      h.handlersWith({ classification: runtime.models.classification }),
      'article.enrich',
      { articleId },
      { queue: 'article.enrich', jobId: 'jev-alias-w14' },
    );
    expect((await h.articleRow(articleId)).state).toBe('enriched');
    expect((await h.facetRow(articleId))?.model).toBe(OLD_MODEL);

    const models = requestedModels();
    expect(models.length).toBeGreaterThanOrEqual(3);
    expect(models[0]).toBe(ALIAS);
    expect(models.slice(1).every((m) => m === OLD_MODEL)).toBe(true);
    expect(models.filter((m) => m === ALIAS)).toHaveLength(1);

    const calls = await h.owner.query<{ kind: string; model: string | null }>(
      `SELECT kind, model FROM engine_calls`,
    );
    const real = calls.rows.filter((r) => r.kind !== 'model_probe');
    expect(real.length).toBeGreaterThanOrEqual(2);
    expect(real.every((r) => r.model === OLD_MODEL)).toBe(true);
    expect(calls.rows.every((r) => r.model !== ALIAS)).toBe(true);

    const pin = await pinRow(h.owner);
    expect(pin).toMatchObject({ model: OLD_MODEL, alias: ALIAS });

    const defaults = {
      model: OLD_MODEL,
      languageModes: h.settingsEnv.languageModes,
      cardTextMode: 'as_written' as const,
    };
    const withAlias = await readRatingFingerprint(h.ownerDb, defaults);
    await setSetting(h.owner, 'engine.model_pin', { model: OLD_MODEL, since: pin!.since });
    const withoutAlias = await readRatingFingerprint(h.ownerDb, defaults);
    expect(withAlias).toBe(withoutAlias);
    // Control: another pinned model does change the fingerprint.
    await setSetting(h.owner, 'engine.model_pin', { model: NEW_MODEL, since: pin!.since });
    expect(await readRatingFingerprint(h.ownerDb, defaults)).not.toBe(withAlias);
  }, 60_000);
});
