import { createUser } from '@bantoozi/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { authTiming } from '../src/services/auth.js';
import { apiClient, createApiHarness, createTestUser, type ApiHarness } from './support/harness.js';

/**
 * D-255: `GET /me` limits and the signup plan come from the stored plans. An edit made in the
 * database (or by an admin) shows at the next request, and changing the default plan changes the
 * plan, and the invites, of the NEXT signup.
 */

let h: ApiHarness;
let seq = 0;

beforeAll(async () => {
  authTiming.minResponseMs = 0;
  h = await createApiHarness({ env: { SIGNUP_MODE: 'open' } });
}, 120_000);

afterAll(async () => {
  await h?.close();
});

async function makeDefault(key: string): Promise<void> {
  await h.owner.query('UPDATE plans SET is_default = false WHERE is_default AND key <> $1', [key]);
  await h.owner.query('UPDATE plans SET is_default = true WHERE key = $1', [key]);
}

afterEach(async () => {
  await makeDefault('beta');
});

async function insertPlan(key: string, over: Record<string, number> = {}): Promise<void> {
  const row: Record<string, string | number | boolean | null> = {
    key,
    label: key,
    label_sk: key,
    max_feeds: 200,
    max_cards: 150,
    max_labels: 20,
    max_forks: 20,
    max_rules: 200,
    opml_max_feeds: 300,
    min_fetch_interval_s: 900,
    release_interval_s: null,
    backfill_days: 7,
    invites_on_signup: 3,
    sort_order: 900,
    is_default: false,
    ...over,
  };
  const columns = Object.keys(row);
  await h.owner.query(
    `INSERT INTO plans (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(row),
  );
}

async function signUp(email: string): Promise<void> {
  const anon = apiClient(h.server);
  expect((await anon.post('/auth/request-code', { email })).statusCode).toBe(202);
  const mail = h.mailer.sent.filter((m) => m.to === email).at(-1);
  const code = mail?.text.match(/\b(\d{6})\b/)?.[1];
  expect(code).toBeDefined();
  const res = await anon.post('/auth/verify', { email, code });
  expect(res.statusCode, res.body).toBe(200);
}

async function userPlan(email: string) {
  const result = await h.owner.query<{ plan: string; invites_left: number }>(
    'SELECT plan, invites_left FROM users WHERE email = $1',
    [email],
  );
  return result.rows[0];
}

describe('GET /me reflects the stored plan', () => {
  it('shows the new limits after the plan is edited', async () => {
    seq += 1;
    const key = `me-plan-${seq}`;
    await insertPlan(key, { max_feeds: 11, max_cards: 12, opml_max_feeds: 13 });
    const user = await createTestUser(h, { plan: key });
    const api = apiClient(h.server, user);
    const before = (await api.get('/me')).json();
    expect(before.plan).toBe(key);
    expect(before.quotas.limits).toMatchObject({ maxFeeds: 11, maxCards: 12, opmlMaxFeeds: 13 });

    await h.owner.query('UPDATE plans SET max_feeds = 21, max_cards = 22 WHERE key = $1', [key]);
    const after = (await api.get('/me')).json();
    expect(after.quotas.limits).toMatchObject({ maxFeeds: 21, maxCards: 22, opmlMaxFeeds: 13 });
  });

  it('gives a user on the seeded admin plan the admin limits', async () => {
    const user = await createTestUser(h, { plan: 'admin' });
    const me = (await apiClient(h.server, user).get('/me')).json();
    expect(me.quotas.limits).toMatchObject({ maxFeeds: 2000, maxCards: 500, opmlMaxFeeds: 2000 });
  });
});

describe('signup uses the default plan', () => {
  it('starts on beta with its invites, then on a new default plan with its own invites', async () => {
    const first = `signup-${++seq}@example.test`;
    await signUp(first);
    expect(await userPlan(first)).toEqual({ plan: 'beta', invites_left: 3 });

    const key = `signup-plan-${seq}`;
    await insertPlan(key, { invites_on_signup: 9 });
    await makeDefault(key);
    const second = `signup-${++seq}@example.test`;
    await signUp(second);
    expect(await userPlan(second)).toEqual({ plan: key, invites_left: 9 });
    // The earlier user keeps the plan they signed up on.
    expect(await userPlan(first)).toEqual({ plan: 'beta', invites_left: 3 });
  });

  it('does not change an existing user when the default changes', async () => {
    const existing = await createUser(h.owner, { email: `exist-${++seq}@example.test` });
    const key = `signup-plan-${seq}`;
    await insertPlan(key);
    await makeDefault(key);
    expect((await userPlan(existing.email))?.plan).toBe('beta');
  });
});
