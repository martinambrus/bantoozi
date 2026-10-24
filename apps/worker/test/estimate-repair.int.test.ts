import { loadEstimateModel, loadEstimateState } from '@bantoozi/db';
import { parseEstimateModel } from '@bantoozi/ranker';
import PgBoss from 'pg-boss';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { estimateAction, loadEstimateInputs } from '../src/estimate/inputs.js';
import { inlineEstimateTrainer } from '../src/estimate/trainer.js';
import { dispatch } from '../src/handlers/index.js';
import { loadRankerSettings } from '../src/rank/settings.js';
import { ClassifyHarness } from './support/classify.js';
import { EstimateWorld } from './support/estimate-world.js';

let h: ClassifyHarness;
let w: EstimateWorld;
let boss: PgBoss;
beforeAll(async () => {
  h = await ClassifyHarness.start();
  w = await EstimateWorld.create(h);
  boss = new PgBoss({
    connectionString: h.testDb.urls.worker,
    migrate: false,
    supervise: false,
    schedule: false,
  });
  await boss.start();
}, 240_000);
afterAll(async () => {
  await boss?.stop({ graceful: false, wait: true });
  await w?.close();
  await h?.close();
});

it.each(['weights', 'platt'] as const)(
  'repairs malformed %s of the current spec with an unchanged input hash and then converges',
  async (column) => {
    const userId = await w.reader(6, 6);
    await h.dispatch('user.estimate', { userId });
    await h.owner.query(
      `UPDATE user_estimate_models SET ${column} = '[]'::jsonb WHERE user_id = $1`,
      [userId],
    );
    const { config } = await loadRankerSettings(h.db);
    const inputs = await loadEstimateInputs(h.db, userId, config, new Date());
    expect(inputs.state?.metrics['inputSha']).toBe(inputs.inputSha);
    expect(estimateAction(inputs)).toBe('train');
    await h.clearOutbox();
    await h.dispatch('user.rank', { userId, reason: 'test' });
    await h.dispatch('user.rank', { userId, reason: 'test' });
    expect(await w.pending('user.estimate', userId)).toHaveLength(1);
    const trainer = vi.fn(inlineEstimateTrainer);
    const handlers = h.handlersWith({ estimateTrainer: trainer });
    const run = () =>
      dispatch(handlers, 'user.estimate', { userId }, { queue: 'user.estimate', jobId: 'direct' });
    await run();
    expect(await w.versions(userId)).toEqual([1, 2]);
    const repaired = await loadEstimateModel(h.db, userId);
    expect(repaired && parseEstimateModel(repaired)).not.toBeNull();
    expect(await w.pending('user.rank', userId)).toHaveLength(1);
    await h.clearOutbox();
    await run();
    await h.dispatch('house.nightly-learn', {});
    expect(trainer).toHaveBeenCalledTimes(1);
    expect(await w.pending('user.estimate', userId)).toHaveLength(0);
  },
);

it('does not write another self-heal intent while an estimate job is already pending', async () => {
  const userId = await w.reader(6, 6);
  await h.dispatch('user.estimate', { userId });
  await h.owner.query(`UPDATE user_estimate_models SET platt = '{}'::jsonb WHERE user_id = $1`, [
    userId,
  ]);
  await h.clearOutbox();
  expect(
    await boss.send('user.estimate', { userId }, { singletonKey: `estimate:${userId}` }),
  ).not.toBeNull();
  await h.dispatch('user.rank', { userId, reason: 'test' });
  await h.dispatch('user.rank', { userId, reason: 'test' });
  expect(await w.pending('user.estimate', userId)).toHaveLength(0);
});

it('deletes a malformed stored model when the gate closes', async () => {
  const userId = await w.reader(6, 6);
  await h.dispatch('user.estimate', { userId });
  await h.owner.query(`UPDATE user_estimate_models SET weights = '[]'::jsonb WHERE user_id = $1`, [
    userId,
  ]);
  await h.setSetting('ranker.thresholds', { estimate: { minRatings: 13 } });
  try {
    await h.clearOutbox();
    await h.dispatch('user.estimate', { userId });
    expect(await w.versions(userId)).toEqual([]);
    expect(await w.pending('user.rank', userId)).toHaveLength(1);
  } finally {
    await h.deleteSetting('ranker.thresholds');
  }
});

it.each([
  ['valid', {}, true],
  ['empty weights', { weights: {} }, true],
  ['weights array', { weights: [] }, false],
  ['weights null', { weights: null }, false],
  ['weights string', { weights: 'broken' }, false],
  ['weight string', { weights: { word: '1' } }, false],
  ['weight null', { weights: { word: null } }, false],
  ['weight object', { weights: { word: {} } }, false],
  ['platt array', { platt: [] }, false],
  ['platt null', { platt: null }, false],
  ['platt missing fields', { platt: {} }, false],
  ['platt missing b', { platt: { a: 1 } }, false],
  ['platt a string', { platt: { a: '1', b: 0 } }, false],
  ['platt b null', { platt: { a: 1, b: null } }, false],
  ['metrics array', { metrics: [] }, true],
] as const)(
  'light state parseability agrees with the full parser for %s',
  async (_name, patch, expected) => {
    const userId = await w.reader(6, 6);
    await h.dispatch('user.estimate', { userId });
    for (const [column, value] of Object.entries(patch)) {
      await h.owner.query(
        `UPDATE user_estimate_models SET ${column} = $2::jsonb WHERE user_id = $1`,
        [userId, JSON.stringify(value)],
      );
    }
    const state = await loadEstimateState(h.db, userId);
    const full = await loadEstimateModel(h.db, userId);
    expect(full).not.toBeNull();
    const parseable = full !== null && parseEstimateModel(full) !== null;
    expect(parseable).toBe(expected);
    expect(state).toHaveProperty('parseable', parseable);
    expect(state).not.toHaveProperty('weights');
    const { config } = await loadRankerSettings(h.db);
    const inputs = await loadEstimateInputs(h.db, userId, config, new Date());
    expect(inputs.state).not.toHaveProperty('weights');
    expect(estimateAction(inputs)).toBe(
      expected && _name !== 'metrics array' ? 'unchanged' : 'train',
    );
  },
);

it.each([
  ['NaN', '0', '{"a":1,"b":0}', false],
  ['Infinity', '0', '{"a":1,"b":0}', false],
  ['-Infinity', '0', '{"a":1,"b":0}', false],
  ['0', '1e400', '{"a":1,"b":0}', false],
  ['0', '-1e400', '{"a":1,"b":0}', false],
  ['0', '1e-400', '{"a":1,"b":0}', true],
  ['0', '1.7976931348623158e308', '{"a":1,"b":0}', true],
  ['0', '0', '{"a":1e400,"b":0}', false],
  ['0', '0', '{"a":1,"b":-1e400}', false],
] as const)(
  'light state matches the parser for intercept %s, weight %s, platt %s',
  async (intercept, weight, platt, expected) => {
    const userId = await w.reader(0, 0);
    await h.owner.query(
      `INSERT INTO user_estimate_models (user_id, version, spec, n, n_pos, n_neg, intercept, weights, platt, metrics)
     VALUES ($1, 1, 'test', 0, 0, 0, $2::float8, $3::jsonb, $4::jsonb, '{}')`,
      [userId, intercept, `{"word":${weight}}`, platt],
    );
    const full = await loadEstimateModel(h.db, userId);
    expect(full).not.toBeNull();
    const parseable = full !== null && parseEstimateModel(full) !== null;
    expect(parseable).toBe(expected);
    expect(await loadEstimateState(h.db, userId)).toHaveProperty('parseable', parseable);
  },
);
