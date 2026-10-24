import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import {
  apiClient,
  createApiHarness,
  createTestUser,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';

let h: ApiHarness;
let users: TestUser[];
const thresholds = { model: { historyDays: 90 } };

beforeAll(async () => {
  h = await createApiHarness();
  users = [await createTestUser(h, { role: 'admin', plan: 'admin' })];
  for (let i = 1; i < 52; i++) users.push(await createTestUser(h));
  // A statement trigger observes actual INSERT statements, including ON CONFLICT, without
  // changing the API executor or granting the API any read/update access to the outbox.
  await h.owner.query(`
    CREATE TABLE test_outbox_statements (queues text[], writer text);
    CREATE FUNCTION test_count_outbox_statements() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
    BEGIN
      INSERT INTO test_outbox_statements
        SELECT array_agg(DISTINCT queue), session_user FROM inserted;
      RETURN NULL;
    END $$;
    CREATE TRIGGER test_count_outbox_statements AFTER INSERT ON job_outbox
      REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT
      EXECUTE FUNCTION test_count_outbox_statements()`);
});

afterAll(async () => h?.close());

beforeEach(async () => {
  await h.owner.query('DELETE FROM job_outbox');
  await h.owner.query('TRUNCATE test_outbox_statements');
  await h.owner.query(
    `DELETE FROM settings WHERE key IN ('ranker.thresholds', 'ranker.settings_version')`,
  );
  await h.owner.query(`UPDATE users SET last_active_at = now() - interval '30 days',
    deleted_at = NULL, rank_revision = 0`);
});

async function activate(n: number) {
  const ids = users.slice(0, n).map((user) => user.id);
  await h.owner.query('UPDATE users SET last_active_at = now() WHERE id = ANY($1::uuid[])', [ids]);
  // An active but deleted reader must not receive work, just like an inactive reader.
  await h.owner.query('UPDATE users SET last_active_at = now(), deleted_at = now() WHERE id = $1', [
    users[51]!.id,
  ]);
  return ids.sort();
}

const patch = () =>
  apiClient(h.server, users[0]!).patch('/admin/settings', { 'ranker.thresholds': thresholds });

it.each([1, 50])(
  'writes the exact three queues for %i active users with three INSERTs',
  async (n) => {
    const ids = await activate(n);
    const res = await patch();
    expect(res.statusCode, res.body).toBe(200);
    const rows = await h.owner.query(`SELECT queue, payload, dedupe_key, user_id,
    available_at = created_at AND available_at <= now() AS immediately_available,
    delivered_at, attempts, lease_token, lease_until, last_error
    FROM job_outbox ORDER BY queue, payload->>'userId'`);
    expect(rows.rows).toEqual(
      ['user.estimate', 'user.learn', 'user.rank'].flatMap((queue) =>
        ids.map((userId) => {
          const payload =
            queue === 'user.rank' ? { full: true, reason: 'settings', userId } : { userId };
          return {
            queue,
            payload,
            dedupe_key: JSON.stringify({ payload, revision: null }),
            user_id: users[0]!.id,
            immediately_available: true,
            delivered_at: null,
            attempts: 0,
            lease_token: null,
            lease_until: null,
            last_error: null,
          };
        }),
      ),
    );
    const revisions = await h.owner.query(
      'SELECT id, rank_revision::int AS revision FROM users ORDER BY id',
    );
    expect(revisions.rows).toEqual(
      users
        .map((user) => ({ id: user.id, revision: ids.includes(user.id) ? 1 : 0 }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
    const statements = await h.owner.query('SELECT queues, writer FROM test_outbox_statements');
    expect(statements.rows).toEqual([
      { queues: ['user.rank'], writer: 'bantoozi_app' },
      { queues: ['user.learn'], writer: 'bantoozi_app' },
      { queues: ['user.estimate'], writer: 'bantoozi_app' },
    ]);
  },
);

it('coalesces pending duplicates without changing their availability, payload or lease', async () => {
  const ids = await activate(3);
  for (const queue of ['user.rank', 'user.learn', 'user.estimate']) {
    const payload =
      queue === 'user.rank'
        ? { full: true, reason: 'settings', userId: ids[0] }
        : { userId: ids[0] };
    await h.owner.query(
      `INSERT INTO job_outbox (queue, payload, dedupe_key, user_id, available_at, lease_token, lease_until)
       VALUES ($1, $2::jsonb, $3, $4, now() + interval '1 hour',
         '00000000-0000-4000-8000-000000000001', now() + interval '2 hours')`,
      [queue, JSON.stringify(payload), JSON.stringify({ payload, revision: null }), users[0]!.id],
    );
  }
  const before = await h.owner.query('SELECT * FROM job_outbox ORDER BY id');
  const res = await patch();
  expect(res.statusCode, res.body).toBe(200);
  const after = await h.owner.query('SELECT * FROM job_outbox ORDER BY id');
  expect(after.rows).toHaveLength(9);
  expect(after.rows.slice(0, 3)).toEqual(before.rows);
});

it('rolls back settings, revisions and all intents if an estimate insert fails', async () => {
  await activate(3);
  await h.owner.query(`ALTER TABLE job_outbox ADD CONSTRAINT test_fail_estimate
    CHECK (queue <> 'user.estimate')`);
  try {
    const res = await patch();
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.details.sqlState).toBe('23514');
    expect((await h.owner.query('SELECT * FROM job_outbox')).rows).toEqual([]);
    expect(
      (
        await h.owner.query(`SELECT key FROM settings
        WHERE key IN ('ranker.thresholds', 'ranker.settings_version')`)
      ).rows,
    ).toEqual([]);
    expect((await h.owner.query('SELECT id FROM users WHERE rank_revision <> 0')).rows).toEqual([]);
  } finally {
    await h.owner.query('ALTER TABLE job_outbox DROP CONSTRAINT test_fail_estimate');
  }
});
