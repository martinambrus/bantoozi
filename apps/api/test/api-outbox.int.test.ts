import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apiClient, createApiHarness, createTestUser, type ApiHarness } from './support/harness.js';

/**
 * M4-T11 enqueue suite, API half (spec 08 §1 "Tenancy", §1.1, §12 "Enqueue"): a real mutation
 * (`POST /rules`, which records `user.rank {full}`) persists its `job_outbox` intent in the state
 * transaction as `bantoozi_app`. When that transaction fails after the intent was written (a
 * deferred constraint trigger raises at COMMIT), the rule, the intent and the idempotency receipt all
 * roll back; a committed mutation keeps exactly one intent, which a retry with the same key does not
 * duplicate and which outlives the API process (a restarted instance sees the same pending intent;
 * nothing depends on an in-memory callback). The relay half — delivery to pg-boss and duplicate
 * delivery after a relay crash — is `apps/worker/test/api-outbox-relay.int.test.ts`; the admin
 * bootstrap row with an empty `invites` table is in `auth.int.test.ts`.
 */

let h: ApiHarness;

const PROBE = 'commit-failure-probe';

beforeAll(async () => {
  h = await createApiHarness();
  // Fails the transaction at COMMIT, i.e. after the handler wrote the rule and its intent.
  await h.owner.query(`
    CREATE FUNCTION test_fail_at_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.value = '${PROBE}' THEN RAISE EXCEPTION 'injected commit failure'; END IF;
      RETURN NULL;
    END $$`);
  await h.owner.query(`
    CREATE CONSTRAINT TRIGGER test_fail_at_commit AFTER INSERT ON user_rules
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_fail_at_commit()`);
});

afterAll(async () => {
  await h.close();
});

async function state(userId: string) {
  const rules = await h.owner.query<{ value: string }>(
    'SELECT value FROM user_rules WHERE user_id = $1 ORDER BY id',
    [userId],
  );
  const intents = await h.owner.query<{ queue: string; payload: Record<string, unknown> }>(
    'SELECT queue, payload FROM job_outbox WHERE user_id = $1 ORDER BY id',
    [userId],
  );
  const receipts = await h.owner.query<{ id: string }>(
    'SELECT id::text FROM api_mutations WHERE user_id = $1',
    [userId],
  );
  const revision = await h.owner.query<{ r: string }>(
    'SELECT rank_revision::text AS r FROM users WHERE id = $1',
    [userId],
  );
  return {
    rules: rules.rows.map((row) => row.value),
    intents: intents.rows,
    receipts: receipts.rows.length,
    rankRevision: revision.rows[0]!.r,
  };
}

describe('API mutations and the transactional outbox', () => {
  it('the server writes as bantoozi_app', async () => {
    const role = await h.appPool.query<{ user: string }>('SELECT current_user AS user');
    expect(role.rows[0]!.user).toBe('bantoozi_app');
  });

  it('a mutation that fails after writing its intent leaves no intent, state or receipt', async () => {
    const user = await createTestUser(h);
    const api = apiClient(h.server, user);
    const failed = await api.post('/rules', { kind: 'mute_keyword', value: PROBE });
    expect(failed.statusCode).toBe(500);
    expect(failed.json().error.code).toBe('INTERNAL');
    expect(await state(user.id)).toEqual({
      rules: [],
      intents: [],
      receipts: 0,
      rankRevision: '0',
    });
  });

  it('a committed mutation persists exactly one intent, kept across retries and a restart', async () => {
    const user = await createTestUser(h);
    const api = apiClient(h.server, user);
    const key = randomUUID();
    const body = { kind: 'mute_keyword', value: 'committed rule' };
    const created = await api.post('/rules', body, { idempotencyKey: key });
    expect(created.statusCode).toBe(201);
    const expected = {
      rules: ['committed rule'],
      intents: [
        { queue: 'user.rank', payload: expect.objectContaining({ userId: user.id, full: true }) },
      ],
      receipts: 1,
      rankRevision: '1',
    };
    expect(await state(user.id)).toEqual(expected);

    // A retry with the same key replays the receipt: no second rule, intent or revision.
    const replay = await api.post('/rules', body, { idempotencyKey: key });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(created.json());
    expect(await state(user.id)).toEqual(expected);

    // "Crash" after commit: a new API instance still sees the durable intent pending for the relay.
    const restarted = await h.buildAnother();
    const again = await apiClient(restarted, user).post('/rules', body, { idempotencyKey: key });
    expect(again.statusCode).toBe(201);
    const pending = await h.owner.query<{ delivered: boolean }>(
      'SELECT delivered_at IS NOT NULL AS delivered FROM job_outbox WHERE user_id = $1',
      [user.id],
    );
    expect(pending.rows).toEqual([{ delivered: false }]);
    expect(await state(user.id)).toEqual(expected);
  });
});
