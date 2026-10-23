import { parseJobPayload } from '@bantoozi/shared';
import { ESTIMATE_SPEC } from '@bantoozi/ranker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { dispatch } from '../src/handlers/index.js';
import { inlineTrainer, type Trainer } from '../src/learn/trainer.js';
import { ClassifyHarness } from './support/classify.js';
import { EstimateWorld } from './support/estimate-world.js';
import { V113, V114, begin, ensureRegistered, flip } from './support/jev4-world.js';
import { LearnWorld, RATED } from './support/learn-world.js';

/**
 * PRG-1 (visible-learning §4.5): the `user_learning_history` rows written by `user.learn` (kind
 * 'model') and `user.estimate` (kind 'estimate') through the real handlers. Rows are read with the
 * owner connection, as the tests of `user_models` do; a trainer stub only produces a rejected
 * (fitted but not activated) or a superseded attempt.
 */

let h: ClassifyHarness;
let lw: LearnWorld;
let ew: EstimateWorld;

beforeAll(async () => {
  h = await ClassifyHarness.start();
  lw = await LearnWorld.create(h);
  ew = await EstimateWorld.create(h);
  await begin(h, V113);
  await ensureRegistered(h);
}, 240_000);

afterAll(async () => {
  await lw?.close();
  await ew?.close();
  await h?.close();
});

interface Hist {
  kind: string;
  n: number;
  auc: number | null;
  baselineAuc: number | null;
  activated: boolean;
  turnedOn: boolean;
  engineModel: string | null;
}

async function history(userId: string, kind?: string): Promise<Hist[]> {
  const result = await h.owner.query<{
    kind: string;
    n: number;
    auc: number | null;
    baseline_auc: number | null;
    activated: boolean;
    turned_on: boolean;
    engine_model: string | null;
  }>(
    `SELECT kind, n, auc, baseline_auc, activated, turned_on, engine_model
       FROM user_learning_history
      WHERE user_id = $1 AND ($2::text IS NULL OR kind = $2) ORDER BY at, id`,
    [userId, kind ?? null],
  );
  return result.rows.map((r) => ({
    kind: r.kind,
    n: r.n,
    auc: r.auc,
    baselineAuc: r.baseline_auc,
    activated: r.activated,
    turnedOn: r.turned_on,
    engineModel: r.engine_model,
  }));
}

const finiteOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

// ── user.learn ─────────────────────────────────────────────────────────────────────────────────

const learn = (userId: string) => h.dispatch('user.learn', { userId });

async function learnWith(trainer: Trainer, userId: string): Promise<void> {
  await dispatch(
    h.handlersWith({ trainer }),
    'user.learn',
    parseJobPayload('user.learn', { userId }),
    { queue: 'user.learn', jobId: 'direct' },
  );
}

/** The real result of the arguments, rejected for `low_auc` (a fitted model that is not activated). */
const rejecting: Trainer = async (args, mode) => {
  const real = await inlineTrainer(args, mode);
  return {
    ...real,
    activation: { eligible: false, reasons: ['low_auc'] },
  } as unknown as Awaited<ReturnType<Trainer>>;
};

/** A real training whose inputs change meanwhile (a new rating), so the attempt is superseded. */
const superseding = (during: () => Promise<void>): Trainer => {
  return async (args, mode) => {
    const real = await inlineTrainer(args, mode);
    await during();
    return real;
  };
};

async function learner(): Promise<string> {
  const userId = await lw.user();
  await lw.rateRange(userId, 0, RATED);
  return userId;
}

describe('user.learn history rows', () => {
  it('an activated run records one model row with the stored attempt’s numbers and the pinned model', async () => {
    const userId = await learner();
    await learn(userId);

    const [model] = await lw.models(userId);
    expect(model?.active).toBe(true);
    const rows = await history(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      kind: 'model',
      n: model!.metrics['nExplicit'],
      auc: finiteOrNull(model!.metrics['cvAuc']),
      baselineAuc: finiteOrNull(model!.metrics['baselineAuc']),
      activated: true,
      turnedOn: true,
      engineModel: V113,
    });
    expect(rows[0]!.n).toBe(RATED);
    expect(rows[0]!.auc).not.toBeNull();
  });

  it('a fitted but rejected attempt records a row that is not activated and not turned on', async () => {
    const userId = await learner();
    await learnWith(rejecting, userId);

    const models = await lw.models(userId);
    expect(models).toHaveLength(1);
    expect(models[0]!.active).toBe(false);
    expect(models[0]!.metrics['status']).toBe('rejected');
    const rows = await history(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'model',
      n: models[0]!.metrics['nExplicit'],
      auc: finiteOrNull(models[0]!.metrics['cvAuc']),
      baselineAuc: finiteOrNull(models[0]!.metrics['baselineAuc']),
      activated: false,
      turnedOn: false,
      engineModel: V113,
    });
  });

  it('a later run that replaces the active model records activated true and turned on false', async () => {
    const userId = await learner();
    await learn(userId);
    await lw.rateRange(userId, RATED, RATED + 12);
    await learn(userId);

    const models = await lw.models(userId);
    expect(models.map((m) => [m.version, m.active])).toEqual([
      [1, false],
      [2, true],
    ]);
    const rows = await history(userId);
    expect(rows.map((r) => [r.activated, r.turnedOn])).toEqual([
      [true, true],
      [true, false],
    ]);
    expect(rows[1]!.n).toBe(models[1]!.metrics['nExplicit']);
  });

  it('records nothing for an unchanged re-run', async () => {
    const userId = await learner();
    await learn(userId);
    await learn(userId);
    await learn(userId);
    expect(await history(userId)).toHaveLength(1);
    expect(await lw.models(userId)).toHaveLength(1);
  });

  it('records nothing for an attempt without a fitted model (under the minimum)', async () => {
    const userId = await lw.user();
    await lw.rateRange(userId, 0, 6);
    await learn(userId);
    const models = await lw.models(userId);
    expect(models).toHaveLength(1);
    expect(models[0]!.active).toBe(false);
    expect(await history(userId)).toEqual([]);
  });

  it('records nothing for a superseded attempt; the follow-up run adds exactly one row', async () => {
    const userId = await learner();
    await learnWith(
      superseding(async () => {
        await lw.rate(userId, RATED + 1);
      }),
      userId,
    );
    const models = await lw.models(userId);
    expect(models.map((m) => m.metrics['status'])).toEqual(['superseded']);
    expect(await history(userId)).toEqual([]);

    await learn(userId);
    expect((await lw.models(userId)).map((m) => m.metrics['status'])).toEqual([
      'superseded',
      'activated',
    ]);
    expect(await history(userId)).toHaveLength(1);
  });

  it('records nothing for a pure deactivation', async () => {
    const userId = await learner();
    await learn(userId);
    expect(await history(userId)).toHaveLength(1);

    // The inputs are unchanged but the active model no longer matches its context: no training,
    // only a deactivation.
    await h.owner.query(
      `UPDATE user_models SET metrics = metrics || '{"contextSha":"stale"}'::jsonb WHERE user_id = $1`,
      [userId],
    );
    await learn(userId);
    expect(await lw.active(userId)).toHaveLength(0);
    expect(await lw.models(userId)).toHaveLength(1);
    expect(await history(userId)).toHaveLength(1);
  });

  it('records one row for parallel runs of the same inputs', async () => {
    const userId = await learner();
    const settled = await Promise.allSettled([learn(userId), learn(userId), learn(userId)]);
    expect(settled.some((s) => s.status === 'fulfilled')).toBe(true);
    expect((await lw.models(userId)).filter((m) => m.active)).toHaveLength(1);
    expect(await history(userId)).toHaveLength(1);
  });

  it('shows the engine model changing from 1.13 to 1.14 between consecutive rows', async () => {
    const userId = await learner();
    await learn(userId);
    await flip(h, V114, { answers: true });
    await ensureRegistered(h);
    await lw.rate(userId, RATED + 2);
    await learn(userId);

    const rows = await history(userId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.engineModel)).toEqual([V113, V114]);
  }, 240_000);
});

// ── user.estimate ──────────────────────────────────────────────────────────────────────────────

const estimate = (userId: string) => h.dispatch('user.estimate', { userId });

describe('user.estimate history rows', () => {
  it('a trained run records one estimate row from the stored model, turned on', async () => {
    const userId = await ew.reader(6, 6);
    await estimate(userId);

    const [model] = await ew.models(userId);
    const rows = await history(userId);
    expect(rows).toEqual([
      {
        kind: 'estimate',
        n: model!.n,
        auc: finiteOrNull(model!.metrics['auc']),
        baselineAuc: null,
        activated: false,
        turnedOn: true,
        engineModel: null,
      },
    ]);
    expect(rows[0]!.n).toBe(12);
  });

  it('the next trained run records turned on false', async () => {
    const userId = await ew.reader(6, 6);
    await estimate(userId);
    await ew.setRating(userId, 0, -1);
    await estimate(userId);
    expect((await history(userId)).map((r) => r.turnedOn)).toEqual([true, false]);
    expect(await ew.versions(userId)).toEqual([1, 2]);
  });

  it('records nothing for unchanged, duplicate or below-gate runs', async () => {
    const unchanged = await ew.reader(6, 6);
    await estimate(unchanged);
    await estimate(unchanged);
    expect(await history(unchanged)).toHaveLength(1);

    const duplicate = await ew.reader(6, 6);
    await Promise.allSettled([estimate(duplicate), estimate(duplicate), estimate(duplicate)]);
    expect(await ew.versions(duplicate)).toEqual([1]);
    expect(await history(duplicate)).toHaveLength(1);

    const below = await ew.reader(5, 4);
    await estimate(below);
    expect(await ew.models(below)).toEqual([]);
    expect(await history(below)).toEqual([]);
  });

  it('records nothing for a gate-closed deletion', async () => {
    const userId = await ew.reader(6, 6);
    await estimate(userId);
    for (const index of [0, 2, 4]) await ew.setRating(userId, index, null);
    await estimate(userId);
    expect(await ew.models(userId)).toEqual([]);
    expect(await history(userId)).toHaveLength(1);
  });

  it('a model stored with another spec is retrained and records turned on true again', async () => {
    const userId = await ew.reader(6, 6);
    await estimate(userId);
    await h.owner.query(
      `UPDATE user_estimate_models SET spec = 'estimate-v0:old' WHERE user_id = $1`,
      [userId],
    );
    await estimate(userId);
    expect((await ew.models(userId)).map((m) => m.spec)).toEqual([
      'estimate-v0:old',
      ESTIMATE_SPEC,
    ]);
    expect((await history(userId)).map((r) => r.turnedOn)).toEqual([true, true]);
  });
});

// ── DEV 3: provenance of the stored estimate model ─────────────────────────────────────────────

describe('estimate model provenance', () => {
  const newest = async (userId: string) => {
    const models = await ew.models(userId);
    return models[models.length - 1]!;
  };

  it('the first model has ratedThrough = its newest rating time and fromRatings false', async () => {
    const userId = await ew.reader(6, 6);
    await estimate(userId);
    const model = await newest(userId);
    expect(model.metrics['ratedThrough']).toBe(ew.ratedAtOf(11).toISOString());
    expect(model.metrics['fromRatings']).toBe(false);
  });

  it('a model trained after a newer rating has fromRatings true and the later ratedThrough', async () => {
    const userId = await ew.reader(6, 6);
    await estimate(userId);
    await ew.setRating(userId, 12, 1);
    await estimate(userId);
    const model = await newest(userId);
    expect(model.version).toBe(2);
    expect(model.metrics['ratedThrough']).toBe(ew.ratedAtOf(12).toISOString());
    expect(model.metrics['fromRatings']).toBe(true);
  });

  it('a retrain without a newer rating (the oldest rating removed) has fromRatings false', async () => {
    const userId = await ew.reader(6, 6);
    await estimate(userId);
    await ew.setRating(userId, 0, null);
    await estimate(userId);
    const model = await newest(userId);
    expect(model.version).toBe(2);
    expect(model.n).toBe(11);
    expect(model.metrics['ratedThrough']).toBe(ew.ratedAtOf(11).toISOString());
    expect(model.metrics['fromRatings']).toBe(false);
  });

  it('a previous model of another spec gives fromRatings false even with a newer rating', async () => {
    const userId = await ew.reader(6, 6);
    await estimate(userId);
    await h.owner.query(
      `UPDATE user_estimate_models SET spec = 'estimate-v0:old' WHERE user_id = $1`,
      [userId],
    );
    await ew.setRating(userId, 12, 1);
    await estimate(userId);
    const model = await newest(userId);
    expect(model.spec).toBe(ESTIMATE_SPEC);
    expect(model.metrics['ratedThrough']).toBe(ew.ratedAtOf(12).toISOString());
    expect(model.metrics['fromRatings']).toBe(false);
  });

  it('a previous model without a valid ratedThrough gives fromRatings false', async () => {
    for (const patch of [
      `metrics - 'ratedThrough'`,
      `metrics || '{"ratedThrough":"not a date"}'::jsonb`,
      `metrics || '{"ratedThrough":null}'::jsonb`,
    ]) {
      const userId = await ew.reader(6, 6);
      await estimate(userId);
      await h.owner.query(`UPDATE user_estimate_models SET metrics = ${patch} WHERE user_id = $1`, [
        userId,
      ]);
      await ew.setRating(userId, 12, 1);
      await estimate(userId);
      const model = await newest(userId);
      expect(model.version).toBe(2);
      expect(model.metrics['ratedThrough']).toBe(ew.ratedAtOf(12).toISOString());
      expect(model.metrics['fromRatings']).toBe(false);
    }
  });
});
