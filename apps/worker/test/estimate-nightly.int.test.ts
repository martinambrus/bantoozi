import { ESTIMATE_SPEC } from '@bantoozi/ranker';
import { parseJobPayload } from '@bantoozi/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { inlineEstimateTrainer } from '../src/estimate/trainer.js';
import { dispatch } from '../src/handlers/index.js';
import { loadRankerSettings } from '../src/rank/settings.js';
import { ClassifyHarness, DAY } from './support/classify.js';
import { EstimateWorld } from './support/estimate-world.js';

/**
 * FNF-VL-3 item 1: `house.nightly-learn` re-enqueues `user.estimate` for exactly the readers whose
 * estimate inputs went stale without a trigger (a rating aging out of `model.historyDays`, a merge
 * changing a rated article, a subscription change, an admin threshold change). `user.estimate`
 * stays the authority: it no-ops on an unchanged input hash.
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

beforeEach(async () => {
  await h.clearOutbox();
});

afterEach(async () => {
  await h.deleteSetting('ranker.thresholds');
});

/** The handler map with a shifted clock (and optionally a trainer). */
function at(now: Date, extra: Parameters<ClassifyHarness['handlersWith']>[0] = {}) {
  const handlers = h.handlersWith({ now: () => now, ...extra });
  return {
    nightly: () =>
      dispatch(handlers, 'house.nightly-learn', parseJobPayload('house.nightly-learn', {}), {
        queue: 'house.nightly-learn',
        jobId: 'direct',
      }),
    estimate: (userId: string) =>
      dispatch(handlers, 'user.estimate', parseJobPayload('user.estimate', { userId }), {
        queue: 'user.estimate',
        jobId: 'direct',
      }),
  };
}

/** A nightly run now; resolves to the pending `user.estimate` intents of the user afterwards. */
async function nightlyFor(userId: string, clock = at(new Date())) {
  await h.clearOutbox();
  await clock.nightly();
  return w.pending('user.estimate', userId);
}

/** A reader with a stored model (trained by the real handler). */
async function trained(likes = 6, dislikes = 6): Promise<string> {
  const userId = await w.reader(likes, dislikes);
  await h.dispatch('user.estimate', { userId });
  expect((await w.versions(userId)).length).toBeGreaterThan(0);
  return userId;
}

describe('house.nightly-learn estimate sweep', () => {
  it('C1 a rating aging out of the history window is picked up the night it does', async () => {
    const t0 = new Date();
    const userId = await w.user();
    await w.rateClasses(userId, 6, 6, (index) =>
      index === 0 ? new Date(t0.getTime() - 179.5 * DAY) : w.ratedAtOf(index),
    );
    await at(t0).estimate(userId);
    expect(await w.versions(userId)).toEqual([1]);

    expect(await nightlyFor(userId, at(t0))).toHaveLength(0);
    const tomorrow = at(new Date(t0.getTime() + DAY));
    expect(await nightlyFor(userId, tomorrow)).toHaveLength(1);

    await tomorrow.estimate(userId);
    const models = await w.models(userId);
    expect(models.map((m) => m.version)).toEqual([1, 2]);
    expect(models[1]).toMatchObject({ n: 11 });
  });

  it('C2 an admin change of the estimate gate values re-trains, deletes or creates a model', async () => {
    const userId = await trained(6, 6);
    expect(await nightlyFor(userId)).toHaveLength(0);

    await h.setSetting('ranker.thresholds', { estimate: { minRatings: 12 } });
    expect(await nightlyFor(userId)).toHaveLength(1);
    await h.dispatch('user.estimate', { userId });
    const models = await w.models(userId);
    expect(models.map((m) => m.version)).toEqual([1, 2]);
    expect((models[1]!.metrics['options'] as Record<string, unknown>)['minRatings']).toBe(12);

    await h.setSetting('ranker.thresholds', { estimate: { minRatings: 13 } });
    expect(await nightlyFor(userId)).toHaveLength(1);
    await h.dispatch('user.estimate', { userId });
    expect(await w.models(userId)).toEqual([]);
    expect(await nightlyFor(userId)).toHaveLength(0);

    await h.deleteSetting('ranker.thresholds');
    const small = await w.reader(4, 3);
    expect(await nightlyFor(small)).toHaveLength(0);
    await h.setSetting('ranker.thresholds', { estimate: { minRatings: 5, minEachClass: 2 } });
    expect(await nightlyFor(small)).toHaveLength(1);
    await h.dispatch('user.estimate', { userId: small });
    expect(await w.versions(small)).toEqual([1]);
  });

  it('C3 an admin change of model.historyDays re-trains on the shorter window', async () => {
    const userId = await w.user();
    await w.rateClasses(userId, 10, 10, (index) =>
      index >= 10 ? new Date(Date.now() - (100 + index) * DAY) : w.ratedAtOf(index),
    );
    await h.dispatch('user.estimate', { userId });
    const [first] = await w.models(userId);
    expect(first!.n).toBe(20);

    expect(await nightlyFor(userId)).toHaveLength(0);
    await h.setSetting('ranker.thresholds', { model: { historyDays: 180 } });
    expect(await nightlyFor(userId)).toHaveLength(0);

    await h.setSetting('ranker.thresholds', { model: { historyDays: 90 } });
    expect(await nightlyFor(userId)).toHaveLength(1);
    await h.dispatch('user.estimate', { userId });
    const models = await w.models(userId);
    expect(models.map((m) => m.version)).toEqual([1, 2]);
    expect(models[1]!.n).toBeLessThan(first!.n);
  });

  it('C4 nothing changed means no intent, no write and no training', async () => {
    const trainer = vi.fn(inlineEstimateTrainer);
    const clock = at(new Date(), { estimateTrainer: trainer });
    const userId = await w.reader(6, 6);
    await clock.estimate(userId);
    expect(trainer).toHaveBeenCalledTimes(1);

    expect(await nightlyFor(userId, clock)).toHaveLength(0);
    expect(await nightlyFor(userId, clock)).toHaveLength(0);
    await clock.estimate(userId);
    expect(trainer).toHaveBeenCalledTimes(1);
    expect(await w.versions(userId)).toEqual([1]);

    await w.setRating(userId, 4, null);
    expect(await nightlyFor(userId, clock)).toHaveLength(1);
    await clock.estimate(userId);
    expect(trainer).toHaveBeenCalledTimes(2);
    expect(await w.versions(userId)).toEqual([1, 2]);

    expect(await nightlyFor(userId, clock)).toHaveLength(0);
    await clock.estimate(userId);
    expect(trainer).toHaveBeenCalledTimes(2);
    expect(await w.versions(userId)).toEqual([1, 2]);
  });

  it('C5 an inactive reader whose ratings all aged out loses the stored model', async () => {
    const userId = await trained(6, 6);
    await h.owner.query(`UPDATE users SET last_active_at = $2 WHERE id = $1`, [
      userId,
      new Date(Date.now() - 30 * DAY),
    ]);
    await h.owner.query(`UPDATE user_article SET rated_at = $2 WHERE user_id = $1`, [
      userId,
      new Date(Date.now() - 200 * DAY),
    ]);
    const userModels = await h.owner.query(`SELECT 1 FROM user_models WHERE user_id = $1`, [
      userId,
    ]);
    expect(userModels.rowCount).toBe(0);

    expect(await nightlyFor(userId)).toHaveLength(1);
    await h.dispatch('user.estimate', { userId });
    expect(await w.models(userId)).toEqual([]);
    expect(await nightlyFor(userId)).toHaveLength(0);
  });

  it('C6 a changed rated article and a lost carrier subscription both re-train', async () => {
    const edited = await trained(6, 6);
    expect(await nightlyFor(edited)).toHaveLength(0);
    await h.owner.query(`UPDATE articles SET title = title || ' (revised)' WHERE id = $1`, [
      w.articles[0],
    ]);
    expect(await nightlyFor(edited)).toHaveLength(1);
    await h.dispatch('user.estimate', { userId: edited });
    expect(await w.versions(edited)).toEqual([1, 2]);

    const unsubscribed = await trained(6, 6);
    // `edited` and `unsubscribed` rate the same articles, whose title changed for both: settle it.
    await h.dispatch('user.estimate', { userId: unsubscribed });
    expect(await nightlyFor(unsubscribed)).toHaveLength(0);
    await h.owner.query(`DELETE FROM subscriptions WHERE user_id = $1`, [unsubscribed]);
    expect(await nightlyFor(unsubscribed)).toHaveLength(1);
    await h.dispatch('user.estimate', { userId: unsubscribed });
    expect((await w.versions(unsubscribed)).length).toBeGreaterThanOrEqual(2);
  });

  it('C7 deleted readers get none, readers with estimates off still do, readers below the gate get none', async () => {
    const gone = await trained(6, 6);
    await w.setRating(gone, 4, null);
    await w.softDelete(gone);
    expect(await nightlyFor(gone)).toHaveLength(0);

    const off = await trained(6, 6);
    await w.setPreferences(off, { estimates: 'off' });
    await w.setRating(off, 4, null);
    expect(await nightlyFor(off)).toHaveLength(1);

    const below = await w.reader(5, 4);
    expect(await nightlyFor(below)).toHaveLength(0);
  });

  it('C8 one failing reader does not stop the sweep or the job', async () => {
    const { enqueueStaleEstimates } = await import('../src/estimate/sweep.js');
    const { loadEstimateInputs } = await import('../src/estimate/inputs.js');
    const users: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const userId = await trained(6, 6);
      await w.setRating(userId, 4, null);
      users.push(userId);
    }
    await h.clearOutbox();
    const warn = vi.fn();
    const deps = { ...h.deps, logger: { ...h.deps.logger, warn } };
    const { config } = await loadRankerSettings(h.db);
    const result = await enqueueStaleEstimates(deps, {
      now: new Date(),
      config,
      loadInputs: async (db, userId, cfg, now) => {
        if (userId === users[1]) throw new Error('boom');
        return loadEstimateInputs(db, userId, cfg, now);
      },
    });
    expect(result.failed).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await w.pending('user.estimate', users[0]!)).toHaveLength(1);
    expect(await w.pending('user.estimate', users[1]!)).toHaveLength(0);
    expect(await w.pending('user.estimate', users[2]!)).toHaveLength(1);

    await h.deleteSetting('house.progress');
    await h.dispatch('house.nightly-learn', {});
    expect(await h.setting('house.progress')).toMatchObject({ 'house.nightly-learn': {} });
  });

  it('C9 paging enqueues every qualifying reader exactly once', async () => {
    const { enqueueStaleEstimates } = await import('../src/estimate/sweep.js');
    const { loadEstimateInputs } = await import('../src/estimate/inputs.js');
    const users: string[] = [];
    for (let i = 0; i < 5; i += 1) users.push(await w.reader(6, 6));
    await h.clearOutbox();
    const { config } = await loadRankerSettings(h.db);
    const seen = new Map<string, number>();
    const result = await enqueueStaleEstimates(h.deps, {
      now: new Date(),
      config,
      pageSize: 2,
      loadInputs: async (db, userId, cfg, now) => {
        seen.set(userId, (seen.get(userId) ?? 0) + 1);
        return loadEstimateInputs(db, userId, cfg, now);
      },
    });
    for (const userId of users) {
      expect(seen.get(userId)).toBe(1);
      expect(await w.pending('user.estimate', userId)).toHaveLength(1);
    }
    expect(result.examined).toBeGreaterThanOrEqual(5);
    expect(result.enqueued).toBeGreaterThanOrEqual(5);
  });

  it('C10 a stored model of another spec is woken once, retrained, and the sweep then converges', async () => {
    const userId = await trained(6, 6);
    expect(await nightlyFor(userId)).toHaveLength(0);
    await h.owner.query(
      `UPDATE user_estimate_models SET spec = 'estimate-v0:old' WHERE user_id = $1`,
      [userId],
    );
    expect(await nightlyFor(userId)).toHaveLength(1);
    await h.dispatch('user.estimate', { userId });
    const models = await w.models(userId);
    expect(models.map((m) => m.spec)).toEqual(['estimate-v0:old', ESTIMATE_SPEC]);
    expect(await nightlyFor(userId)).toHaveLength(0);
  });
});
