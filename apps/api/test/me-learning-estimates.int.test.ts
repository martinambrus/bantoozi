import { ESTIMATE_SPEC } from '@bantoozi/ranker';
import { LearningStatusSchema } from '@bantoozi/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  apiClient,
  createApiHarness,
  createTestUser,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';

/**
 * EST-4 (visible-learning §4.4): `GET /me/learning` reports `estimates` from the stored word model
 * (size, quality, last refresh), null while no usable model of the current spec exists, and never
 * the model's weights or calibration.
 */

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness();
});

afterAll(async () => {
  await h.close();
});

const TRAINED_AT = new Date('2026-10-20T08:30:00.000Z');
const LAST_RUN = { at: '2026-10-21T06:00:00.000Z', movedUp: 12, movedDown: 30 };

async function storeModel(
  user: TestUser,
  options: { spec?: string; n?: number; metrics?: Record<string, unknown> } = {},
): Promise<void> {
  const n = options.n ?? 23;
  await h.owner.query(
    `INSERT INTO user_estimate_models (user_id, version, spec, trained_at, n, n_pos, n_neg,
                                       intercept, weights, platt, metrics)
     VALUES ($1, 1, $2, $3, $4, $5, $6, -0.25, $7::jsonb, $8::jsonb, $9::jsonb)`,
    [
      user.id,
      options.spec ?? ESTIMATE_SPEC,
      TRAINED_AT,
      n,
      Math.ceil(n / 2),
      n - Math.ceil(n / 2),
      JSON.stringify({ 't:battery': 0.5, 't:court': -0.4 }),
      JSON.stringify({ a: 1.1, b: -0.2 }),
      JSON.stringify(options.metrics ?? { auc: 0.71, lastRun: LAST_RUN }),
    ],
  );
}

async function read(user: TestUser) {
  const res = await apiClient(h.server, user).get('/me/learning');
  expect(res.statusCode, res.body).toBe(200);
  return { raw: res.json<Record<string, unknown>>(), body: res.body };
}

describe('GET /me/learning estimates', () => {
  it('is null, with the key present, while no model is stored', async () => {
    const user = await createTestUser(h);
    const { raw } = await read(user);
    expect(raw).toHaveProperty('estimates', null);
    expect(LearningStatusSchema.parse(raw).estimates).toBeNull();
  });

  it('reports the stored model: size, AUC, training time and the last refresh', async () => {
    const user = await createTestUser(h);
    await storeModel(user);
    const { raw } = await read(user);
    expect(raw.estimates).toEqual({
      n: 23,
      auc: 0.71,
      trainedAt: TRAINED_AT.toISOString(),
      lastRun: LAST_RUN,
    });
    expect(LearningStatusSchema.parse(raw).estimates).toEqual(raw.estimates);
  });

  it('reads lastRun as null, and still answers 200, when the stored value is malformed', async () => {
    for (const lastRun of [
      'yesterday',
      { at: 'not a time', movedUp: 1, movedDown: 2 },
      { at: LAST_RUN.at, movedUp: -3, movedDown: 2 },
      { at: LAST_RUN.at, movedUp: 1 },
      { ...LAST_RUN, extra: true },
      null,
    ]) {
      const user = await createTestUser(h);
      await storeModel(user, { metrics: { auc: 0.71, lastRun } });
      const { raw } = await read(user);
      expect(raw.estimates, JSON.stringify(lastRun)).toEqual({
        n: 23,
        auc: 0.71,
        trainedAt: TRAINED_AT.toISOString(),
        lastRun: null,
      });
    }
  });

  it('reads auc as null when the metrics hold none', async () => {
    const withoutAuc = await createTestUser(h);
    await storeModel(withoutAuc, { metrics: { lastRun: LAST_RUN } });
    expect((await read(withoutAuc)).raw.estimates).toMatchObject({ n: 23, auc: null });

    const nullAuc = await createTestUser(h);
    await storeModel(nullAuc, { metrics: { auc: null, lastRun: LAST_RUN } });
    expect((await read(nullAuc)).raw.estimates).toMatchObject({ n: 23, auc: null });
  });

  it('is null for a model of another spec', async () => {
    const user = await createTestUser(h);
    await storeModel(user, { spec: 'estimate-v0:0000000000000000' });
    const { raw } = await read(user);
    expect(raw).toHaveProperty('estimates', null);
  });

  it('never shows one account the model of another', async () => {
    const alice = await createTestUser(h);
    const bob = await createTestUser(h);
    await storeModel(alice);
    expect((await read(alice)).raw.estimates).toMatchObject({ n: 23 });
    expect((await read(bob)).raw).toHaveProperty('estimates', null);
  });

  it('does not send the weights or the calibration', async () => {
    const user = await createTestUser(h);
    await storeModel(user);
    const { body } = await read(user);
    expect(body).not.toContain('weights');
    expect(body).not.toContain('platt');
    expect(body).not.toContain('t:battery');
  });

  it('is independent of the estimates preference', async () => {
    const user = await createTestUser(h);
    await storeModel(user);
    const api = apiClient(h.server, user);
    for (const estimates of ['off', 'on']) {
      await h.owner.query(
        `UPDATE users SET preferences = coalesce(preferences, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
        [user.id, JSON.stringify({ estimates })],
      );
      const res = await api.get('/me/learning');
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().estimates, estimates).toMatchObject({ n: 23, auc: 0.71 });
    }
  });
});
