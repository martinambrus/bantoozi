import { MeSchema } from '@bantoozi/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { clearOutbox } from './support/article-fixtures.js';
import { apiClient, createApiHarness, createTestUser, type ApiHarness } from './support/harness.js';

/**
 * EST-2 (visible-learning §4.4): the `estimates` preference through `GET/PATCH /me`: default 'on',
 * validation, the full rank every ranking preference records, and one `user.estimate` intent when
 * (and only when) the value changed.
 */

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness();
});

afterAll(async () => {
  await h.close();
});

async function rankRevision(userId: string): Promise<number> {
  const result = await h.owner.query<{ r: number }>(
    'SELECT rank_revision::int AS r FROM users WHERE id = $1',
    [userId],
  );
  return result.rows[0]!.r;
}

async function outbox(queue: string, userId: string) {
  const result = await h.owner.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM job_outbox WHERE queue = $1 AND payload->>'userId' = $2 ORDER BY id`,
    [queue, userId],
  );
  return result.rows.map((r) => r.payload);
}

describe('the estimates preference', () => {
  it('reads on for an account whose stored preferences lack the key', async () => {
    const alice = await createTestUser(h);
    await h.owner.query(
      `UPDATE users SET preferences = coalesce(preferences, '{}'::jsonb) - 'estimates' WHERE id = $1`,
      [alice.id],
    );
    const res = await apiClient(h.server, alice).get('/me');
    expect(res.statusCode, res.body).toBe(200);
    expect(MeSchema.parse(res.json()).preferences).toMatchObject({ estimates: 'on' });
  });

  it('records a full rank and one user.estimate intent, and no user.learn, when it is turned off', async () => {
    const alice = await createTestUser(h);
    const a = apiClient(h.server, alice);
    const revision = await rankRevision(alice.id);

    const res = await a.patch('/me', { preferences: { estimates: 'off' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().preferences.estimates).toBe('off');
    expect(await rankRevision(alice.id)).toBe(revision + 1);
    expect(await outbox('user.rank', alice.id)).toEqual([
      { userId: alice.id, reason: 'preferences', full: true },
    ]);
    expect(await outbox('user.estimate', alice.id)).toEqual([{ userId: alice.id }]);
    expect(await outbox('user.learn', alice.id)).toEqual([]);
  });

  it('records nothing when the same value is sent again, and records again when it is turned on', async () => {
    const alice = await createTestUser(h);
    const a = apiClient(h.server, alice);
    await a.patch('/me', { preferences: { estimates: 'off' } });
    await clearOutbox(h, alice.id);
    const revision = await rankRevision(alice.id);

    const again = await a.patch('/me', { preferences: { estimates: 'off' } });
    expect(again.statusCode, again.body).toBe(200);
    expect(await rankRevision(alice.id)).toBe(revision);
    expect(await outbox('user.estimate', alice.id)).toEqual([]);
    expect(await outbox('user.rank', alice.id)).toEqual([]);

    const on = await a.patch('/me', { preferences: { estimates: 'on' } });
    expect(on.statusCode, on.body).toBe(200);
    expect(await rankRevision(alice.id)).toBe(revision + 1);
    expect(await outbox('user.estimate', alice.id)).toEqual([{ userId: alice.id }]);
    expect(await outbox('user.rank', alice.id)).toEqual([
      { userId: alice.id, reason: 'preferences', full: true },
    ]);
    expect(await outbox('user.learn', alice.id)).toEqual([]);
  });

  it('rejects an unknown value with VALIDATION_FAILED and changes nothing', async () => {
    const alice = await createTestUser(h);
    const a = apiClient(h.server, alice);
    const before = (await a.get('/me')).json();
    const res = await a.patch('/me', { preferences: { estimates: 'maybe' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
    expect((await a.get('/me')).json()).toEqual(before);
    expect(await outbox('user.estimate', alice.id)).toEqual([]);
  });

  it('records no user.estimate intent for another preference', async () => {
    const alice = await createTestUser(h);
    const a = apiClient(h.server, alice);
    expect((await a.patch('/me', { preferences: { theme: 'light' } })).statusCode).toBe(200);
    expect(await outbox('user.estimate', alice.id)).toEqual([]);
    expect((await a.patch('/me', { preferences: { demote: { stale: 'off' } } })).statusCode).toBe(
      200,
    );
    expect(await outbox('user.rank', alice.id)).toEqual([
      { userId: alice.id, reason: 'preferences', full: true },
    ]);
    expect(await outbox('user.estimate', alice.id)).toEqual([]);
  });
});
