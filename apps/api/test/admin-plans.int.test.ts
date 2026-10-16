import { randomUUID } from 'node:crypto';

import { createFeed, createSubscription, createUser } from '@bantoozi/testing';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  apiClient,
  createApiHarness,
  createTestUser,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';

/**
 * D-255 (docs/design/plan-velocity.md §6): the admin plan routes, plan choices for users, and the
 * live effect of an edit on feed intervals. Response shapes pinned here: list `{ items }`; create,
 * patch and default answer `{ plan }`; a plan is `{ key, label, labelSk, maxFeeds, maxCards,
 * maxLabels, maxForks, maxRules, opmlMaxFeeds, minFetchIntervalS, releaseIntervalS, backfillDays,
 * invitesOnSignup, sortOrder, isDefault, retiredAt, version, userCount }`. `version` is passed back
 * unchanged as `expectedVersion`.
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
  await h.close();
});

const tag = () => randomUUID().slice(0, 8);
const as = (user: TestUser = admin) => apiClient(h.server, user);

interface PlanDto {
  key: string;
  label: string;
  labelSk: string | null;
  maxFeeds: number;
  maxCards: number;
  maxLabels: number;
  maxForks: number;
  maxRules: number;
  opmlMaxFeeds: number;
  minFetchIntervalS: number;
  releaseIntervalS: number | null;
  backfillDays: number;
  invitesOnSignup: number;
  sortOrder: number;
  isDefault: boolean;
  retiredAt: string | null;
  version: number | string;
  userCount: number;
}

const body = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  label: `Plan ${key}`,
  labelSk: `Plán ${key}`,
  maxFeeds: 10,
  maxCards: 11,
  maxLabels: 12,
  maxForks: 13,
  maxRules: 14,
  opmlMaxFeeds: 15,
  minFetchIntervalS: 1200,
  releaseIntervalS: null,
  backfillDays: 5,
  invitesOnSignup: 2,
  sortOrder: 700,
  ...over,
});

async function list(): Promise<PlanDto[]> {
  const res = await as().get('/admin/plans');
  expect(res.statusCode, res.body).toBe(200);
  return res.json().items as PlanDto[];
}

async function find(key: string): Promise<PlanDto> {
  const plan = (await list()).find((p) => p.key === key);
  expect(plan, key).toBeDefined();
  return plan!;
}

async function create(key = `p-${tag()}`, over: Record<string, unknown> = {}): Promise<PlanDto> {
  const res = await as().post('/admin/plans', body(key, over));
  expect(res.statusCode, res.body).toBe(201);
  return res.json().plan as PlanDto;
}

function expectError(res: LightMyRequestResponse, status: number, code?: string) {
  expect(res.statusCode, res.body).toBe(status);
  if (code !== undefined) expect(res.json().error.code).toBe(code);
}

describe('access', () => {
  const routes: [string, string][] = [
    ['GET', '/admin/plans'],
    ['POST', '/admin/plans'],
    ['PATCH', '/admin/plans/beta'],
    ['POST', '/admin/plans/beta/default'],
    ['DELETE', '/admin/plans/beta'],
  ];

  it('answers 403 to an ordinary user and 401 to an anonymous GET', async () => {
    for (const [method, url] of routes) {
      const client = as(reader);
      const res =
        method === 'GET'
          ? await client.get(url)
          : method === 'POST'
            ? await client.post(url, {})
            : method === 'PATCH'
              ? await client.patch(url, {})
              : await client.delete(url);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    }
    expect((await apiClient(h.server).get('/admin/plans')).statusCode).toBe(401);
  });
});

describe('GET /admin/plans', () => {
  it('lists the seeded plans sorted by sort_order with user counts and the default flag', async () => {
    const plans = await list();
    const orders = plans.map((p) => p.sortOrder);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    const keys = plans.map((p) => p.key);
    expect(keys).toEqual(
      expect.arrayContaining(['beta', 'admin', 'free', 'basic', 'plus', 'pro', 'max', 'premium']),
    );
    const beta = plans.find((p) => p.key === 'beta')!;
    expect(beta).toMatchObject({
      isDefault: true,
      retiredAt: null,
      maxFeeds: 200,
      minFetchIntervalS: 900,
      invitesOnSignup: 3,
    });
    expect(beta.userCount).toBeGreaterThanOrEqual(1);
    expect(plans.find((p) => p.key === 'admin')!.userCount).toBeGreaterThanOrEqual(1);
    expect(plans.find((p) => p.key === 'premium')!.minFetchIntervalS).toBe(60);
    expect(plans.filter((p) => p.isDefault).map((p) => p.key)).toEqual(['beta']);
  });

  it('counts the users on a plan', async () => {
    const plan = await create();
    expect(plan.userCount).toBe(0);
    await createUser(h.owner, { plan: plan.key });
    await createUser(h.owner, { plan: plan.key });
    expect((await find(plan.key)).userCount).toBe(2);
  });
});

describe('POST /admin/plans', () => {
  it('creates a plan with typed limits and starts it at version 1, active and not default', async () => {
    const key = `new-${tag()}`;
    const plan = await create(key);
    expect(plan).toMatchObject({
      key,
      label: `Plan ${key}`,
      labelSk: `Plán ${key}`,
      maxFeeds: 10,
      maxCards: 11,
      maxLabels: 12,
      maxForks: 13,
      maxRules: 14,
      opmlMaxFeeds: 15,
      minFetchIntervalS: 1200,
      releaseIntervalS: null,
      backfillDays: 5,
      invitesOnSignup: 2,
      sortOrder: 700,
      isDefault: false,
      retiredAt: null,
      userCount: 0,
    });
    expect(Number(plan.version)).toBe(1);
    expect(await find(key)).toMatchObject({ key, maxFeeds: 10 });
  });

  it('answers 409 to a duplicate key', async () => {
    const key = `dup-${tag()}`;
    await create(key);
    expectError(await as().post('/admin/plans', body(key)), 409);
    expectError(await as().post('/admin/plans', body('beta')), 409);
  });

  it('answers 400 VALIDATION_FAILED to an invalid key or limit', async () => {
    for (const bad of [
      body('Bad Key!'),
      body(''),
      body(`k-${tag()}`, { minFetchIntervalS: 59 }),
      body(`k-${tag()}`, { minFetchIntervalS: 86401 }),
      body(`k-${tag()}`, { maxFeeds: -1 }),
      body(`k-${tag()}`, { maxFeeds: 1.5 }),
      body(`k-${tag()}`, { label: '' }),
    ]) {
      expectError(await as().post('/admin/plans', bad), 400, 'VALIDATION_FAILED');
    }
  });
});

describe('PATCH /admin/plans/:key', () => {
  it('edits labels, limits and sort order, bumps the version and refuses a stale one', async () => {
    const plan = await create();
    const res = await as().patch(`/admin/plans/${plan.key}`, {
      expectedVersion: plan.version,
      label: 'Renamed',
      labelSk: 'Premenovaný',
      maxFeeds: 77,
      sortOrder: 5,
    });
    expect(res.statusCode, res.body).toBe(200);
    const edited = res.json().plan as PlanDto;
    expect(edited).toMatchObject({
      key: plan.key,
      label: 'Renamed',
      labelSk: 'Premenovaný',
      maxFeeds: 77,
      sortOrder: 5,
      maxCards: 11,
    });
    expect(Number(edited.version)).toBe(Number(plan.version) + 1);

    const stale = await as().patch(`/admin/plans/${plan.key}`, {
      expectedVersion: plan.version,
      maxFeeds: 1,
    });
    expectError(stale, 409, 'STALE_STATE');
    expect((await find(plan.key)).maxFeeds).toBe(77);
  });

  it('answers 400 VALIDATION_FAILED to an invalid limit and 404 to an unknown plan', async () => {
    const plan = await create();
    for (const bad of [
      { minFetchIntervalS: 30 },
      { minFetchIntervalS: 100000 },
      { maxCards: -5 },
      { maxRules: 'many' },
      { label: '' },
    ]) {
      expectError(
        await as().patch(`/admin/plans/${plan.key}`, { expectedVersion: plan.version, ...bad }),
        400,
        'VALIDATION_FAILED',
      );
    }
    expectError(
      await as().patch('/admin/plans/does-not-exist', { expectedVersion: 1, maxFeeds: 3 }),
      404,
    );
  });

  it('never changes the key', async () => {
    const plan = await create();
    const res = await as().patch(`/admin/plans/${plan.key}`, {
      expectedVersion: plan.version,
      key: 'other',
    });
    expect([400, 200]).toContain(res.statusCode);
    expect((await list()).some((p) => p.key === 'other')).toBe(false);
    expect((await find(plan.key)).key).toBe(plan.key);
  });

  it('retires and unretires a plan', async () => {
    const plan = await create();
    const retired = await as().patch(`/admin/plans/${plan.key}`, {
      expectedVersion: plan.version,
      retired: true,
    });
    expect(retired.statusCode, retired.body).toBe(200);
    const after = await find(plan.key);
    expect(after.retiredAt).not.toBeNull();
    const back = await as().patch(`/admin/plans/${plan.key}`, {
      expectedVersion: after.version,
      retired: false,
    });
    expect(back.statusCode, back.body).toBe(200);
    expect((await find(plan.key)).retiredAt).toBeNull();
  });

  it('refuses to retire the default plan', async () => {
    const beta = await find('beta');
    expectError(
      await as().patch('/admin/plans/beta', { expectedVersion: beta.version, retired: true }),
      409,
    );
    expect((await find('beta')).retiredAt).toBeNull();
  });
});

describe('POST /admin/plans/:key/default', () => {
  it('makes a plan the only default, then restores beta', async () => {
    const plan = await create();
    const res = await as().post(`/admin/plans/${plan.key}/default`, {});
    expect(res.statusCode, res.body).toBe(200);
    expect((await list()).filter((p) => p.isDefault).map((p) => p.key)).toEqual([plan.key]);
    expect((await as().post('/admin/plans/beta/default', {})).statusCode).toBe(200);
    expect((await list()).filter((p) => p.isDefault).map((p) => p.key)).toEqual(['beta']);
  });

  it('refuses a retired plan with 409 and an unknown plan with 404', async () => {
    const plan = await create();
    await as().patch(`/admin/plans/${plan.key}`, { expectedVersion: plan.version, retired: true });
    expectError(await as().post(`/admin/plans/${plan.key}/default`, {}), 409);
    expect((await find('beta')).isDefault).toBe(true);
    expectError(await as().post('/admin/plans/does-not-exist/default', {}), 404);
  });
});

describe('DELETE /admin/plans/:key', () => {
  it('deletes an unused plan with 204', async () => {
    const plan = await create();
    const res = await as().delete(`/admin/plans/${plan.key}`);
    expect(res.statusCode, res.body).toBe(204);
    expect((await list()).some((p) => p.key === plan.key)).toBe(false);
  });

  it('refuses a plan in use or the default plan with 409', async () => {
    const plan = await create();
    await createUser(h.owner, { plan: plan.key });
    expectError(await as().delete(`/admin/plans/${plan.key}`), 409);
    expect((await find(plan.key)).userCount).toBe(1);
    expectError(await as().delete('/admin/plans/beta'), 409);
    expect((await find('beta')).isDefault).toBe(true);
  });
});

describe('a plan edit applies to feed intervals live', () => {
  async function feedRow(id: string) {
    const result = await h.owner.query<{
      min_interval_s: number;
      next_fetch_at: Date;
      last_fetch_at: Date | null;
    }>('SELECT min_interval_s, next_fetch_at, last_fetch_at FROM feeds WHERE id = $1', [id]);
    return result.rows[0]!;
  }

  /** A feed last fetched 20 minutes ago, next due in 2 hours, with the sentinel floor. */
  async function slowFeed(sentinel: number) {
    const feed = await createFeed(h.owner);
    await h.owner.query(
      `UPDATE feeds SET min_interval_s = $2, last_fetch_at = now() - interval '20 minutes',
                        next_fetch_at = now() + interval '2 hours' WHERE id = $1`,
      [feed.id, sentinel],
    );
    return feed;
  }

  it('recomputes only the feeds with a live subscriber on that plan and pulls next_fetch_at forward', async () => {
    const plan = await create(undefined, { minFetchIntervalS: 7200 });
    const other = await create(undefined, { minFetchIntervalS: 7200 });
    const onPlan = await createUser(h.owner, { plan: plan.key });
    const onOther = await createUser(h.owner, { plan: other.key });
    const mine = await slowFeed(7200);
    const theirs = await slowFeed(777);
    await createSubscription(h.owner, { userId: onPlan.id, feedId: mine.id, mode: 'active' });
    await createSubscription(h.owner, { userId: onOther.id, feedId: theirs.id, mode: 'active' });
    const theirsBefore = await feedRow(theirs.id);

    const res = await as().patch(`/admin/plans/${plan.key}`, {
      expectedVersion: plan.version,
      minFetchIntervalS: 600,
    });
    expect(res.statusCode, res.body).toBe(200);

    const after = await feedRow(mine.id);
    expect(after.min_interval_s).toBe(600);
    expect(after.next_fetch_at.getTime()).toBeLessThanOrEqual(
      after.last_fetch_at!.getTime() + 600_000,
    );
    expect(await feedRow(theirs.id)).toEqual(theirsBefore);
  });

  it('raising the floor recomputes the interval but never pushes next_fetch_at later', async () => {
    const plan = await create(undefined, { minFetchIntervalS: 600 });
    const user = await createUser(h.owner, { plan: plan.key });
    const feed = await createFeed(h.owner);
    await h.owner.query(
      `UPDATE feeds SET min_interval_s = 600, last_fetch_at = now() - interval '5 minutes',
                        next_fetch_at = now() + interval '5 minutes' WHERE id = $1`,
      [feed.id],
    );
    await createSubscription(h.owner, { userId: user.id, feedId: feed.id, mode: 'active' });
    const before = await feedRow(feed.id);

    const res = await as().patch(`/admin/plans/${plan.key}`, {
      expectedVersion: plan.version,
      minFetchIntervalS: 7200,
    });
    expect(res.statusCode, res.body).toBe(200);
    const after = await feedRow(feed.id);
    expect(after.min_interval_s).toBe(7200);
    expect(after.next_fetch_at.getTime()).toBeLessThanOrEqual(before.next_fetch_at.getTime());
  });

  it("a user plan change recomputes only that user's feeds and pulls their next fetch forward", async () => {
    const slow = await create(undefined, { minFetchIntervalS: 7200 });
    const fast = await create(undefined, { minFetchIntervalS: 300 });
    const user = await createUser(h.owner, { plan: slow.key });
    const bystander = await createUser(h.owner, { plan: slow.key });
    const mine = await slowFeed(7200);
    const theirs = await slowFeed(777);
    await createSubscription(h.owner, { userId: user.id, feedId: mine.id, mode: 'active' });
    await createSubscription(h.owner, { userId: bystander.id, feedId: theirs.id, mode: 'active' });
    const theirsBefore = await feedRow(theirs.id);

    const res = await as().patch(`/admin/users/${user.id}`, { plan: fast.key });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().user.plan).toBe(fast.key);

    const after = await feedRow(mine.id);
    expect(after.min_interval_s).toBe(300);
    expect(after.next_fetch_at.getTime()).toBeLessThanOrEqual(
      after.last_fetch_at!.getTime() + 300_000,
    );
    expect(await feedRow(theirs.id)).toEqual(theirsBefore);
  });
});

describe('PATCH /admin/users/:id plan choices', () => {
  it('accepts any existing plan key, including a newly created one, and refuses an unknown key', async () => {
    const plan = await create();
    const user = await createUser(h.owner);
    const ok = await as().patch(`/admin/users/${user.id}`, { plan: plan.key });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().user.plan).toBe(plan.key);
    const bad = await as().patch(`/admin/users/${user.id}`, { plan: 'gold-nonexistent' });
    expect([400, 404, 409]).toContain(bad.statusCode);
    expect(bad.statusCode).not.toBe(200);
    const stored = await h.owner.query<{ plan: string }>('SELECT plan FROM users WHERE id = $1', [
      user.id,
    ]);
    expect(stored.rows[0]?.plan).toBe(plan.key);
  });

  it("refuses a retired plan unless it is the user's current plan", async () => {
    const plan = await create();
    const member = await createUser(h.owner, { plan: plan.key });
    const outsider = await createUser(h.owner);
    await as().patch(`/admin/plans/${plan.key}`, { expectedVersion: plan.version, retired: true });

    const refused = await as().patch(`/admin/users/${outsider.id}`, { plan: plan.key });
    expect(refused.statusCode, refused.body).toBeGreaterThanOrEqual(400);
    expect(refused.statusCode).toBeLessThan(500);
    const unchanged = await h.owner.query<{ plan: string }>(
      'SELECT plan FROM users WHERE id = $1',
      [outsider.id],
    );
    expect(unchanged.rows[0]?.plan).toBe('beta');

    const kept = await as().patch(`/admin/users/${member.id}`, { plan: plan.key, invitesLeft: 4 });
    expect(kept.statusCode, kept.body).toBe(200);
    expect(kept.json().user).toMatchObject({ plan: plan.key, invitesLeft: 4 });
  });

  it('filters GET /admin/users by plan', async () => {
    const plan = await create();
    const a = await createUser(h.owner, { plan: plan.key });
    const b = await createUser(h.owner, { plan: plan.key });
    await createUser(h.owner);
    const res = await as().get('/admin/users', { query: { plan: plan.key } });
    expect(res.statusCode, res.body).toBe(200);
    const ids = (res.json().items as { id: string; plan: string }[]).map((u) => u.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
    for (const u of res.json().items as { plan: string }[]) expect(u.plan).toBe(plan.key);
  });
});

describe('a plan edit reaches GET /me', () => {
  it('shows the edited limits on the next request', async () => {
    const plan = await create(undefined, { maxFeeds: 8 });
    const user = await createTestUser(h, { plan: plan.key });
    expect((await as(user).get('/me')).json().quotas.limits.maxFeeds).toBe(8);
    const res = await as().patch(`/admin/plans/${plan.key}`, {
      expectedVersion: plan.version,
      maxFeeds: 9,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await as(user).get('/me')).json().quotas.limits.maxFeeds).toBe(9);
  });
});
