import {
  bindTenant,
  loadEstimateModel,
  loadEstimateRatings,
  lockUserForVerify,
  restoreSoftDeletedUser,
} from '@bantoozi/db';
import { ESTIMATE_SPEC, estimateInputSha, trainEstimateModel } from '@bantoozi/ranker';
import { parseJobPayload } from '@bantoozi/shared';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { inlineEstimateTrainer } from '../src/estimate/trainer.js';
import { dispatch } from '../src/handlers/index.js';
import { ClassifyHarness, DAY } from './support/classify.js';
import { ESTIMATE_OPTIONS, EstimateWorld } from './support/estimate-world.js';

/**
 * EST-2 (visible-learning §4.4): the `user.estimate` handler through the registered handler map
 * against a migrated database: it trains the reader's word model from the explicit ratings of the
 * last `model.historyDays` days, stores it (two versions are kept), records the estimate refresh
 * rank, and does nothing when the inputs did not change.
 */

let h: ClassifyHarness;
let w: EstimateWorld;

beforeAll(async () => {
  h = await ClassifyHarness.start();
  w = await EstimateWorld.create(h);
}, 240_000);

afterAll(async () => {
  await w?.close();
  await h?.close();
});

const estimate = (userId: string) => h.dispatch('user.estimate', { userId });

/** A handler map whose trainer is a spy around the real one. */
function spied() {
  const trainer = vi.fn(inlineEstimateTrainer);
  const handlers = h.handlersWith({ estimateTrainer: trainer });
  return {
    trainer,
    run: (userId: string) =>
      dispatch(handlers, 'user.estimate', parseJobPayload('user.estimate', { userId }), {
        queue: 'user.estimate',
        jobId: 'direct',
      }),
  };
}

const estimateRanks = async (userId: string, since = '0') =>
  (await h.payloads('user.rank', since)).filter(
    (p) => p['userId'] === userId && p['reason'] === 'estimate',
  );

describe('user.estimate', () => {
  it('(1) trains 12 ratings, stores version 1 equal to the pure trainer and records one estimate rank', async () => {
    const userId = await w.reader(6, 6);
    const mark = await h.mark();
    await estimate(userId);

    const ratings = await loadEstimateRatings(h.db, userId, new Date(0));
    expect(ratings).toHaveLength(12);
    const expected = trainEstimateModel(ratings, ESTIMATE_OPTIONS);
    if (!expected.ok) throw new Error('the fixture must open the gate');
    const stored = await loadEstimateModel(h.db, userId);
    expect(stored).not.toBeNull();
    expect(stored).toMatchObject({
      version: 1,
      spec: expected.model.spec,
      n: 12,
      nPos: 6,
      nNeg: 6,
    });
    expect(stored!.spec).toBe(ESTIMATE_SPEC);
    expect(stored!.intercept).toEqual(expected.model.intercept);
    expect(stored!.weights).toEqual(expected.model.weights);
    expect(stored!.platt).toEqual(expected.model.platt);
    expect(stored!.metrics['inputSha']).toBe(estimateInputSha(ratings, ESTIMATE_OPTIONS));
    expect(stored!.metrics['options']).toEqual(ESTIMATE_OPTIONS);

    expect(await h.intents('user.rank', { since: mark, pending: true })).toHaveLength(1);
    expect(await estimateRanks(userId, mark)).toEqual([
      { userId, reason: 'estimate', estimate: {} },
    ]);
  });

  it('(2) a second run with unchanged inputs trains nothing and writes nothing', async () => {
    const userId = await w.reader(6, 6);
    const { trainer, run } = spied();
    const mark = await h.mark();
    await run(userId);
    await run(userId);
    expect(trainer).toHaveBeenCalledTimes(1);
    expect(await w.versions(userId)).toEqual([1]);
    expect(await estimateRanks(userId, mark)).toHaveLength(1);

    await h.clearOutbox();
    const mark2 = await h.mark();
    await run(userId);
    expect(trainer).toHaveBeenCalledTimes(1);
    expect(await h.payloads('user.rank', mark2)).toEqual([]);
    expect(await h.payloads('user.estimate', mark2)).toEqual([]);
  });

  it('(3) an un-rate retrains as version 2 (n = 11) and the same rating again gives version 3 with the weights of version 1', async () => {
    const userId = await w.reader(6, 6);
    await estimate(userId);
    const [first] = await w.models(userId);

    await w.setRating(userId, 4, null);
    await estimate(userId);
    const afterUnrate = await w.models(userId);
    expect(afterUnrate.map((m) => m.version)).toEqual([1, 2]);
    expect(afterUnrate[1]).toMatchObject({ n: 11, nPos: 5, nNeg: 6 });

    await w.setRating(userId, 4, 1, w.ratedAtOf(4));
    await estimate(userId);
    const models = await w.models(userId);
    expect(models.map((m) => m.version)).toEqual([2, 3]);
    expect(models[1]).toMatchObject({ n: 12 });
    expect(models[1]!.weights).toEqual(first!.weights);
    expect(models[1]!.intercept).toEqual(first!.intercept);
    expect(models[1]!.platt).toEqual(first!.platt);
    expect(models[1]!.metrics['inputSha']).toBe(first!.metrics['inputSha']);
  });

  it('(4a) below the gate (9 ratings) stores no model and records no intent', async () => {
    const userId = await w.reader(5, 4);
    const { trainer, run } = spied();
    const mark = await h.mark();
    await run(userId);
    expect(trainer).not.toHaveBeenCalled();
    expect(await w.models(userId)).toEqual([]);
    expect(await h.payloads('user.rank', mark)).toEqual([]);
  });

  it('(4b) below the gate (12 ratings with 2 dislikes) stores no model and records no intent', async () => {
    const userId = await w.reader(10, 2);
    const { trainer, run } = spied();
    const mark = await h.mark();
    await run(userId);
    expect(trainer).not.toHaveBeenCalled();
    expect(await w.models(userId)).toEqual([]);
    expect(await h.payloads('user.rank', mark)).toEqual([]);
  });

  it('(4c) a stored model is deleted when the ratings fall below the gate, with one estimate rank, and a further run does nothing', async () => {
    const userId = await w.reader(6, 6);
    await estimate(userId);
    expect(await w.versions(userId)).toEqual([1]);

    await h.clearOutbox();
    const mark = await h.mark();
    for (const index of [0, 2, 4]) await w.setRating(userId, index, null);
    await estimate(userId);
    expect(await w.models(userId)).toEqual([]);
    expect(await estimateRanks(userId, mark)).toEqual([
      { userId, reason: 'estimate', estimate: {} },
    ]);
    expect(await h.intents('user.rank', { since: mark, pending: true })).toHaveLength(1);

    await h.clearOutbox();
    const mark2 = await h.mark();
    await estimate(userId);
    expect(await w.models(userId)).toEqual([]);
    expect(await h.payloads('user.rank', mark2)).toEqual([]);
  });

  it('(5) a stored model of another spec is retrained even when the inputs are unchanged', async () => {
    const userId = await w.reader(6, 6);
    await estimate(userId);
    await h.owner.query(
      `UPDATE user_estimate_models SET spec = 'estimate-v0:old' WHERE user_id = $1`,
      [userId],
    );
    const { trainer, run } = spied();
    await run(userId);
    expect(trainer).toHaveBeenCalledTimes(1);
    const models = await w.models(userId);
    expect(models.map((m) => [m.version, m.spec])).toEqual([
      [1, 'estimate-v0:old'],
      [2, ESTIMATE_SPEC],
    ]);

    await run(userId);
    expect(trainer).toHaveBeenCalledTimes(1);
    expect(await w.versions(userId)).toEqual([1, 2]);
  });

  it('(6) keeps only the two newest versions after three trainings', async () => {
    const userId = await w.reader(6, 6);
    await estimate(userId);
    await w.setRating(userId, 0, -1);
    await estimate(userId);
    await w.setRating(userId, 2, -1);
    await estimate(userId);
    const models = await w.models(userId);
    expect(models.map((m) => m.version)).toEqual([2, 3]);
    expect(models.map((m) => m.n)).toEqual([12, 12]);
    expect(models.map((m) => m.nPos)).toEqual([5, 4]);
  });

  it('(7) a soft-deleted user neither throws nor writes; the restore queues one run that stores the model; an unknown user is ignored', async () => {
    const userId = await w.reader(6, 6);
    await w.softDelete(userId);
    const mark = await h.mark();
    await estimate(userId);
    expect(await w.models(userId)).toEqual([]);
    expect(await h.payloads('user.rank', mark)).toEqual([]);

    await h.clearOutbox();
    const restoreMark = await h.mark();
    await h.db.transaction(async (tx) => {
      const row = await lockUserForVerify(tx, userId);
      expect(row?.restorable).toBe(true);
      await restoreSoftDeletedUser(await bindTenant(tx, userId));
    });
    expect(await w.pending('user.estimate', userId)).toEqual([{ userId }]);
    expect(
      (await h.intents('user.estimate', { since: restoreMark, pending: true })).map(
        (intent) => intent.payload,
      ),
    ).toEqual([{ userId }]);

    await estimate(userId);
    expect(await w.versions(userId)).toEqual([1]);

    await expect(estimate(randomUUID())).resolves.toBeUndefined();
  });

  it('(8a) trains whatever prefs.estimates says', async () => {
    const userId = await w.reader(6, 6);
    await w.setPreferences(userId, { estimates: 'off' });
    await estimate(userId);
    expect(await w.versions(userId)).toEqual([1]);
  });

  it('(8b) raising config.estimate.minRatings through ranker.thresholds closes the gate for 12 ratings', async () => {
    const userId = await w.reader(6, 6);
    await h.setSetting('ranker.thresholds', { estimate: { minRatings: 20 } });
    try {
      const { trainer, run } = spied();
      const mark = await h.mark();
      await run(userId);
      expect(trainer).not.toHaveBeenCalled();
      expect(await w.models(userId)).toEqual([]);
      expect(await h.payloads('user.rank', mark)).toEqual([]);
    } finally {
      await h.deleteSetting('ranker.thresholds');
    }
  });

  it('(8c) the trainer receives the thresholds of the ranker settings', async () => {
    const userId = await w.reader(6, 6);
    await h.setSetting('ranker.thresholds', { estimate: { minRatings: 11, minEachClass: 4 } });
    try {
      const { trainer, run } = spied();
      await run(userId);
      expect(trainer).toHaveBeenCalledTimes(1);
      expect(trainer.mock.calls[0]![1]).toMatchObject({ minRatings: 11, minEachClass: 4 });
      const stored = await loadEstimateModel(h.db, userId);
      expect(stored!.metrics['options']).toMatchObject({ minRatings: 11, minEachClass: 4 });
    } finally {
      await h.deleteSetting('ranker.thresholds');
    }
  });

  it('(9) ratings older than model.historyDays are not trained on', async () => {
    const userId = await w.reader(6, 6);
    const old = new Date(Date.now() - 200 * DAY);
    for (const index of [20, 21, 22, 23]) {
      await w.setRating(userId, index, index % 2 === 0 ? 1 : -1, old);
    }
    await estimate(userId);
    const [model] = await w.models(userId);
    expect(model).toMatchObject({ version: 1, n: 12, nPos: 6, nNeg: 6 });

    const windowed = await loadEstimateRatings(h.db, userId, new Date(Date.now() - 180 * DAY));
    expect(windowed).toHaveLength(12);
    expect(model!.metrics['inputSha']).toBe(estimateInputSha(windowed, ESTIMATE_OPTIONS));
  });

  it('(9b) old ratings do not open the gate on their own', async () => {
    const userId = await w.user();
    const old = new Date(Date.now() - 200 * DAY);
    await w.rateClasses(userId, 5, 5, () => old);
    await w.setRating(userId, 30, 1);
    await w.setRating(userId, 31, -1);
    const { trainer, run } = spied();
    await run(userId);
    expect(trainer).not.toHaveBeenCalled();
    expect(await w.models(userId)).toEqual([]);
  });
});
