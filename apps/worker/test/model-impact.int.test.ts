import type { EngineModelProbe } from '@bantoozi/shared';
import { createUser } from '@bantoozi/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { dispatch } from '../src/handlers/index.js';
import { createModelProbeHandler } from '../src/handlers/model-probe.js';
import type { createModelProber } from '../src/model-probe.js';
import { recordModelProbe } from '../src/model-probe.js';

import { ClassifyHarness } from './support/classify.js';
import {
  ALIAS,
  NOW,
  V113,
  V114,
  failedProbe,
  impactOf,
  iso,
  okProbe,
  probeOf,
  rawSetting,
  runWatch,
  scriptedProber,
  seedModel,
  settingValue,
  watchContext,
  watchRow,
} from './support/model-watch-world.js';

/**
 * JEV-5 (worker): every recorded model probe also records `settings['engine.model_impact']` in the
 * same transaction: how many live users hold an active personal model, as of the probe's `at`.
 */

type Prober = ReturnType<typeof createModelProber>;

let h: ClassifyHarness;
const logger = { info: () => {}, warn: () => {}, error: () => {} };

beforeAll(async () => {
  h = await ClassifyHarness.start();
}, 240_000);

afterAll(async () => {
  await h?.close();
});

beforeEach(async () => {
  await h.owner.query(`DELETE FROM user_models`);
  await h.owner.query(`DELETE FROM settings WHERE key = ANY($1::text[])`, [
    ['engine.model_probe', 'engine.model_impact', 'engine.model_watch', 'house.progress'],
  ]);
});

const user = async (deletedAt?: Date): Promise<string> =>
  (await createUser(h.owner, deletedAt === undefined ? {} : { deletedAt })).id;

const A = '2031-03-01T10:00:00.000Z';
const B = '2031-03-01T11:00:00.000Z';
const okAt = (at: string, requested = ALIAS, answered = V113): EngineModelProbe => ({
  requested,
  answered,
  ok: true,
  at,
});

describe('I: recordModelProbe records the impact in the same transaction', () => {
  it('I0 no personal models: zero, with the probe record', async () => {
    await recordModelProbe(h.db, okAt(A));
    expect(await impactOf(h.owner)).toEqual({ at: A, activeModels: 0 });
    expect(await probeOf(h.owner)).toEqual(okAt(A));
  });

  it('I1 one live user with one active model', async () => {
    await seedModel(h.owner, await user());
    await recordModelProbe(h.db, okAt(A));
    expect(await impactOf(h.owner)).toEqual({ at: A, activeModels: 1 });
  });

  it('I2 counts one per user: inactive versions of a user with an active one do not add', async () => {
    await seedModel(h.owner, await user());
    await seedModel(h.owner, await user());
    const third = await user();
    await seedModel(h.owner, third, { version: 1, active: false });
    await seedModel(h.owner, third, { version: 2, active: true });
    await recordModelProbe(h.db, okAt(A));
    expect((await impactOf(h.owner))?.activeModels).toBe(3);
  });

  it('I3 a soft-deleted user is not counted, and is again once restored', async () => {
    const kept = await user();
    const gone = await user();
    await seedModel(h.owner, kept);
    await seedModel(h.owner, gone);
    await seedModel(h.owner, await user(new Date('2031-01-01T00:00:00Z')));
    await recordModelProbe(h.db, okAt(A));
    expect((await impactOf(h.owner))?.activeModels).toBe(2);

    await h.owner.query(`UPDATE users SET deleted_at = now() WHERE id = $1`, [gone]);
    await recordModelProbe(h.db, okAt(B));
    expect(await impactOf(h.owner)).toEqual({ at: B, activeModels: 1 });

    await h.owner.query(`UPDATE users SET deleted_at = NULL WHERE id = $1`, [gone]);
    await recordModelProbe(h.db, okAt('2031-03-01T12:00:00.000Z'));
    expect((await impactOf(h.owner))?.activeModels).toBe(2);
  });

  it('I4 only inactive (rejected) models: zero', async () => {
    await seedModel(h.owner, await user(), { active: false });
    await recordModelProbe(h.db, okAt(A));
    expect((await impactOf(h.owner))?.activeModels).toBe(0);
  });

  it('I5 a failed probe also records the impact; a later ok probe moves at and the count', async () => {
    await seedModel(h.owner, await user());
    await seedModel(h.owner, await user());
    const failed: EngineModelProbe = {
      requested: 'jev-1.99.0',
      ok: false,
      at: B,
      error: 'model_unavailable',
    };
    await recordModelProbe(h.db, failed);
    expect(await impactOf(h.owner)).toEqual({ at: B, activeModels: 2 });
    const record = await probeOf(h.owner, 'jev-1.99.0');
    expect(record).toMatchObject({ ok: false, error: 'model_unavailable' });
    expect(record).not.toHaveProperty('answered');

    await seedModel(h.owner, await user());
    await recordModelProbe(h.db, okAt('2031-03-01T12:00:00.000Z'));
    expect(await impactOf(h.owner)).toEqual({ at: '2031-03-01T12:00:00.000Z', activeModels: 3 });
  });

  it('I6 a refused impact write rolls back the probe record too', async () => {
    await seedModel(h.owner, await user());
    await recordModelProbe(h.db, okAt(A));
    const probeBefore = await rawSetting(h.owner, 'engine.model_probe');
    const impactBefore = await rawSetting(h.owner, 'engine.model_impact');
    expect(impactBefore).not.toBeNull();

    await h.owner.query(`
      CREATE FUNCTION refuse_impact() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'impact refused'; END $$`);
    await h.owner.query(`
      CREATE TRIGGER refuse_impact BEFORE INSERT OR UPDATE ON settings
        FOR EACH ROW WHEN (NEW.key = 'engine.model_impact')
        EXECUTE FUNCTION refuse_impact()`);
    try {
      await seedModel(h.owner, await user());
      await expect(recordModelProbe(h.db, okAt(B, 'jev-1.14.0', V114))).rejects.toThrow();
    } finally {
      await h.owner.query(`DROP TRIGGER refuse_impact ON settings`);
      await h.owner.query(`DROP FUNCTION refuse_impact()`);
    }
    expect(await rawSetting(h.owner, 'engine.model_probe')).toEqual(probeBefore);
    expect(await rawSetting(h.owner, 'engine.model_impact')).toEqual(impactBefore);
  });

  it('I7 the engine.model-probe handler records the impact, also for a throwing prober', async () => {
    await seedModel(h.owner, await user());
    const started = Date.now();
    const throwing = {
      probe: async () => {
        throw new Error('boom');
      },
    } as unknown as Prober;
    await createModelProbeHandler({ db: h.db, prober: throwing, logger })(
      { model: ALIAS },
      { queue: 'engine.model-probe', jobId: 'impact' },
    );
    expect(await probeOf(h.owner)).toMatchObject({ ok: false, error: 'internal_error' });
    const impact = await impactOf(h.owner);
    expect(impact?.activeModels).toBe(1);
    expect(Date.parse(impact!.at)).toBeGreaterThanOrEqual(started - 1000);
    expect((await probeOf(h.owner))?.at).toBe(impact!.at);
  });

  it('I8 house.model-watch records the impact for an ok and a failed probe, not for a concrete setting', async () => {
    await seedModel(h.owner, await user());
    await runWatch(h, { prober: scriptedProber(failedProbe('timeout')) });
    expect(await impactOf(h.owner)).toEqual({ at: iso(NOW), activeModels: 1 });

    await h.owner.query(`DELETE FROM settings WHERE key = ANY($1::text[])`, [
      ['engine.model_probe', 'engine.model_impact', 'engine.model_watch', 'house.progress'],
    ]);
    await runWatch(h, { prober: scriptedProber(okProbe(V113)) });
    expect(await impactOf(h.owner)).toEqual({ at: iso(NOW), activeModels: 1 });

    await h.owner.query(`DELETE FROM settings WHERE key = ANY($1::text[])`, [
      ['engine.model_probe', 'engine.model_impact', 'engine.model_watch', 'house.progress'],
    ]);
    await runWatch(h, { prober: scriptedProber(okProbe(V114)), configured: V113 });
    expect(await impactOf(h.owner)).toBeUndefined();
    expect(await settingValue(h.owner, 'engine.model_probe')).toBeUndefined();
  });

  it('I9 concurrent recorders: no deadlock, at most 10 probe keys, one impact row', async () => {
    await seedModel(h.owner, await user());
    const base = Date.UTC(2031, 5, 1);
    const ids = Array.from({ length: 20 }, (_, i) => `jev-1.${i}.0`);
    await Promise.all(
      ids.map((id, i) =>
        recordModelProbe(h.db, okAt(new Date(base + i * 60_000).toISOString(), id, id)),
      ),
    );
    const probes = await settingValue<Record<string, unknown>>(h.owner, 'engine.model_probe');
    expect(Object.keys(probes ?? {}).length).toBeLessThanOrEqual(10);
    const impact = await impactOf(h.owner);
    expect(impact?.activeModels).toBe(1);
    const stamps = ids.map((_, i) => new Date(base + i * 60_000).toISOString());
    expect(stamps).toContain(impact?.at);
  });
});

describe('Check now sees a setting changed seconds ago', () => {
  it('the watch handler asks the runtime settings cache to reload before it reads the model', async () => {
    const current = V113;
    let stale = true;
    const runtimeSettings = {
      invalidate: () => {
        stale = false;
      },
      get: async () => ({ values: { typesafeModel: stale ? current : ALIAS } }),
    };
    const handlers = h.handlersWith({
      runtimeSettings: runtimeSettings as never,
      providerValidation: {
        router: {} as never,
        credentials: {} as never,
        config: {
          nodeEnv: 'test',
          typesafeBaseUrl: 'http://127.0.0.1:9',
          typesafeModel: current,
          typesafePricePerMtokUsd: 0.042,
          ollamaBaseUrl: 'http://127.0.0.1:9',
          ollamaModelFast: 'fast',
          ollamaModelStrong: 'strong',
        },
      },
    });
    await dispatch(handlers, 'house.model-watch', {}, watchContext());
    expect(stale).toBe(false);
    expect((await watchRow(h.owner)).lastCheck).toBeDefined();
    expect(await probeOf(h.owner)).toMatchObject({ requested: ALIAS, ok: false });
  });
});
