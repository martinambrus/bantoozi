import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  apiClient,
  createApiHarness,
  createTestUser,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';
import { clearSnapshots, storeSnapshot } from './support/metrics-snapshots.js';

/**
 * M8-T4 (PLAN §14): the admin overview shows the like-rate per lane and the regret rate (the
 * observed recovery from Everything/Hidden of spec 10 §7, numerator and eligible denominator) from
 * the latest `metrics.daily.<date>` snapshot, and nothing when none exists.
 *
 * Response field fixed by this harness: `metrics`, `null` when there is no snapshot, otherwise
 * `{ day, lanes: {<lane>: {likeRate, rated}}, regret: {numerator, denominator, rate} }`.
 */

let h: ApiHarness;
let admin: TestUser;
let reader: TestUser;

beforeAll(async () => {
  h = await createApiHarness();
  admin = await createTestUser(h, { role: 'admin', plan: 'admin' });
  reader = await createTestUser(h);
});

afterAll(async () => {
  await h?.close();
});

afterEach(async () => {
  await clearSnapshots(h.owner);
});

describe('GET /admin/overview metrics (M8-T4)', () => {
  it('returns the like-rate per lane and the regret rate from the latest snapshot', async () => {
    await storeSnapshot(h.owner, {
      day: '2026-10-01',
      lanes: { for_you: { likeRate: 0.1, rated: 3 } },
      regret: { numerator: 9, denominator: 9 },
    });
    await storeSnapshot(h.owner, {
      day: '2026-10-03',
      lanes: {
        for_you: { likeRate: 0.8, rated: 50 },
        maybe: { likeRate: 0.6, rated: 40 },
        everything: { likeRate: 0.1, rated: 12 },
        hidden: { likeRate: null, rated: 0 },
      },
      regret: { numerator: 3, denominator: 40 },
    });
    await storeSnapshot(h.owner, {
      day: '2026-10-02',
      lanes: { for_you: { likeRate: 0.2, rated: 7 } },
      regret: { numerator: 1, denominator: 2 },
    });

    const res = await apiClient(h.server, admin).get('/admin/overview');

    expect(res.statusCode).toBe(200);
    expect(res.json().metrics).toEqual({
      day: '2026-10-03',
      lanes: {
        for_you: { likeRate: 0.8, rated: 50 },
        maybe: { likeRate: 0.6, rated: 40 },
        everything: { likeRate: 0.1, rated: 12 },
        hidden: { likeRate: null, rated: 0 },
      },
      regret: { numerator: 3, denominator: 40, rate: 0.075 },
    });
  });

  it('reports a null regret rate when no downranked article was eligible', async () => {
    await storeSnapshot(h.owner, {
      day: '2026-10-03',
      lanes: { for_you: { likeRate: 0.5, rated: 2 } },
      regret: { numerator: 0, denominator: 0 },
    });

    const res = await apiClient(h.server, admin).get('/admin/overview');

    expect(res.statusCode).toBe(200);
    expect(res.json().metrics.regret).toEqual({ numerator: 0, denominator: 0, rate: null });
  });

  it('returns null metrics when no snapshot exists and keeps the rest of the overview', async () => {
    const res = await apiClient(h.server, admin).get('/admin/overview');

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.metrics ?? null).toBeNull();
    expect(body.users.total).toBeGreaterThanOrEqual(2);
  });

  it('answers 403 to an ordinary user, with or without a snapshot', async () => {
    await storeSnapshot(h.owner, {
      day: '2026-10-03',
      lanes: { for_you: { likeRate: 0.5, rated: 2 } },
      regret: { numerator: 1, denominator: 2 },
    });

    const res = await apiClient(h.server, reader).get('/admin/overview');

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    expect(JSON.stringify(res.json())).not.toContain('likeRate');
  });
});
