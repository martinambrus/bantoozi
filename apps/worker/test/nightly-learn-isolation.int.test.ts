import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';

import { dispatch } from '../src/handlers/index.js';
import * as learnInputs from '../src/learn/inputs.js';
import { ClassifyHarness } from './support/classify.js';
import { EstimateWorld } from './support/estimate-world.js';

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
afterEach(() => {
  vi.restoreAllMocks();
});

it('continues past a failing learn reader, sweeps estimates and records completion and failure counts', async () => {
  const users = [await w.reader(6, 6), await w.reader(6, 6), await w.reader(6, 6)].sort();
  await h.owner.query('UPDATE users SET last_active_at = now() WHERE id = ANY($1::uuid[])', [
    users,
  ]);
  const bad = users[0]!;
  const error = new Error('broken learn reader');
  const original = learnInputs.loadLearnInputs;
  vi.spyOn(learnInputs, 'loadLearnInputs').mockImplementation(async (...args) => {
    if (args[2] === bad) throw error;
    return original(...args);
  });
  const warn = vi.fn();
  const errorLog = vi.fn();
  const handlers = h.handlersWith({ logger: { ...h.deps.logger, warn, error: errorLog } });
  await h.clearOutbox();
  await h.deleteSetting('house.progress');
  await expect(
    dispatch(
      handlers,
      'house.nightly-learn',
      {},
      { queue: 'house.nightly-learn', jobId: 'direct' },
    ),
  ).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({ userId: bad, err: error }),
    expect.any(String),
  );
  for (const userId of users.slice(1))
    expect(await w.pending('user.learn', userId)).toHaveLength(1);
  expect(await w.pending('user.learn', bad)).toHaveLength(0);
  for (const userId of users) expect(await w.pending('user.estimate', userId)).toHaveLength(1);
  expect(await h.setting('house.progress')).toMatchObject({
    'house.nightly-learn': { completedAt: expect.any(String) },
  });
  expect(errorLog).toHaveBeenCalledWith(
    expect.objectContaining({ job: 'house.nightly-learn', examined: 3, learn: 2, failed: 1 }),
    'nightly learn enqueued',
  );
});

it('fails an entirely broken run only after sweeping estimates and writing progress', async () => {
  const userId = await w.reader(6, 6);
  vi.spyOn(learnInputs, 'loadLearnInputs').mockRejectedValue(new Error('systematic failure'));
  const error = vi.fn();
  const handlers = h.handlersWith({ logger: { ...h.deps.logger, error } });
  await h.clearOutbox();
  await h.deleteSetting('house.progress');
  await expect(
    dispatch(
      handlers,
      'house.nightly-learn',
      {},
      { queue: 'house.nightly-learn', jobId: 'direct' },
    ),
  ).rejects.toThrow('All examined users failed nightly learn');
  expect(await w.pending('user.estimate', userId)).toHaveLength(1);
  expect(await h.setting('house.progress')).toMatchObject({
    'house.nightly-learn': { completedAt: expect.any(String) },
  });
  expect(error).toHaveBeenCalledWith(
    expect.objectContaining({ job: 'house.nightly-learn', learn: 0, failed: expect.any(Number) }),
    'nightly learn enqueued',
  );
  const summary = error.mock.calls[0]?.[0] as { examined: number; failed: number };
  expect(summary.failed).toBeGreaterThan(0);
  expect(summary.failed).toBe(summary.examined);
});
