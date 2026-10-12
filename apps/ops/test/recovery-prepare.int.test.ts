import { MIGRATIONS_FOLDER, PG_BOSS_VERSION, runMigrations } from '@bantoozi/db';
import {
  createArticle,
  createFeed,
  createUser,
  dropCreatedTestDatabases,
  setupTestDatabase,
  type TestDatabase,
} from '@bantoozi/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { formatRecovery, prepareRecovery } from '../src/recovery-prepare.js';

/**
 * `recovery:prepare` (spec 11 §4.1 step 4) against a migrated database standing in for a restored
 * copy: stale `active` pg-boss jobs are requeued (or failed when out of retries), outbox and origin leases are reset, and queued
 * jobs and undelivered intents are kept.
 */

let testDb: TestDatabase;
let pool: pg.Pool;

const stateOf = async (name: string): Promise<string[]> =>
  (
    await pool.query<{ state: string }>(
      'SELECT state::text AS state FROM pgboss.job WHERE name = $1 ORDER BY state::text',
      [name],
    )
  ).rows.map((row) => row.state);

beforeAll(async () => {
  testDb = await setupTestDatabase({
    pkg: 'ops',
    migrationsDir: MIGRATIONS_FOLDER,
    pgBossVersion: PG_BOSS_VERSION,
    migrate: async (url) => {
      await runMigrations({ databaseUrl: url });
    },
  });
  pool = new pg.Pool({ connectionString: testDb.urls.admin, max: 3 });
  await pool.query("SELECT pgboss.create_queue('recovery.test', '{}')");
  await pool.query(
    `INSERT INTO pgboss.job (name, data, state, started_on)
     VALUES ('recovery.test', '{}', 'active', now() - interval '3 hours'),
            ('recovery.test', '{"n":2}', 'active', now() - interval '2 hours'),
            ('recovery.test', '{"n":3}', 'created', NULL),
            ('recovery.test', '{"n":4}', 'completed', now() - interval '1 hour')`,
  );
  // Job 1 has retries left; job 2 has exhausted them (retry_count = retry_limit).
  await pool.query(
    `UPDATE pgboss.job SET retry_limit = 2, retry_count = CASE WHEN data = '{}'::jsonb THEN 1 ELSE 2 END
      WHERE name = 'recovery.test' AND state = 'active'`,
  );
  await pool.query(
    `INSERT INTO job_outbox (queue, payload, dedupe_key, lease_token, lease_until)
     VALUES ('user.rank', '{}', 'live', gen_random_uuid(), now() + interval '1 hour'),
            ('user.rank', '{}', 'stale', gen_random_uuid(), now() - interval '1 hour')`,
  );
  await pool.query(
    "INSERT INTO job_outbox (queue, payload, dedupe_key) VALUES ('user.rank', '{}', 'plain')",
  );
  await pool.query(
    `INSERT INTO job_outbox (queue, payload, dedupe_key, delivered_at)
     VALUES ('user.rank', '{}', 'done', now())`,
  );
  const user = await createUser(pool, { email: 'recovery@example.test' });
  const feed = await createFeed(pool);
  const article = await createArticle(pool, { feedIds: [feed.id] });
  // The insert trigger wants a live subscription and carrier; a restored copy already holds the rows.
  await pool.query('ALTER TABLE analysis_requests DISABLE TRIGGER USER');
  await pool.query(
    `INSERT INTO analysis_requests (id, user_id, feed_id, article_id, article_revision, inference_version,
                                    input_snapshot, input_sha, status, lease_token, lease_until, attempts)
     VALUES (gen_random_uuid(), $1, $2, $3, 1, 1, '{}', 'a', 'running', gen_random_uuid(), now() + interval '1 hour', 2),
            (gen_random_uuid(), $1, $2, $3, 1, 2, '{}', 'b', 'running', gen_random_uuid(), now() - interval '1 hour', 0),
            (gen_random_uuid(), $1, $2, $3, 1, 3, '{}', 'c', 'pending', NULL, NULL, 0)`,
    [user.id, feed.id, article.id],
  );
  await pool.query('ALTER TABLE analysis_requests ENABLE TRIGGER USER');
  await pool.query(
    `INSERT INTO origin_fetch_state (origin, leases)
     VALUES ('https://leased.example', jsonb_build_array(jsonb_build_object('token', 't', 'expires_at', to_char(now() + interval '1 hour', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))),
            ('https://idle.example', '[]')`,
  );
});

afterAll(async () => {
  await pool.end();
  await dropCreatedTestDatabases();
});

describe('recovery:prepare', () => {
  it('requeues active jobs, resets leases, keeps queued work, and is idempotent', async () => {
    const report = await prepareRecovery(pool);
    expect(report).toEqual({
      activeJobsRequeued: 1,
      activeJobsFailed: 1,
      outboxLeasesCleared: 2,
      originLeasesCleared: 1,
      analysisLeasesReset: 2,
      outboxPending: 3,
    });
    expect(formatRecovery(report)).toBe(
      'RECOVERY_PREPARE active_jobs_requeued=1 active_jobs_failed=1 outbox_leases_cleared=2 origin_leases_cleared=1 analysis_leases_reset=2 outbox_pending=3',
    );
    expect(await stateOf('recovery.test')).toEqual(['completed', 'created', 'failed', 'retry']);
    // The requeued job is runnable now and keeps its data; the exhausted one is finished, not active.
    const runnable = await pool.query(
      "SELECT data, retry_count FROM pgboss.job WHERE name = 'recovery.test' AND state = 'retry' AND start_after <= now()",
    );
    expect(runnable.rows).toEqual([{ data: {}, retry_count: 1 }]);
    const failed = await pool.query(
      "SELECT output FROM pgboss.job WHERE name = 'recovery.test' AND state = 'failed' AND completed_on IS NOT NULL",
    );
    expect(failed.rows).toHaveLength(1);
    // pg-boss 10.4.2 fetch (plans.fetchNextJob): the requeued job is the next eligible one.
    const fetched = await pool.query(
      `SELECT id, data FROM pgboss.job
        WHERE name = 'recovery.test' AND state < 'active' AND start_after < now()
        ORDER BY priority DESC, created_on, id FOR UPDATE SKIP LOCKED`,
    );
    expect(fetched.rows.map((row: { data: unknown }) => row.data)).toContainEqual({});
    expect(fetched.rows).toHaveLength(2);
    const leased = await pool.query(
      'SELECT count(*)::int AS n FROM job_outbox WHERE lease_token IS NOT NULL OR lease_until IS NOT NULL',
    );
    expect(leased.rows[0]).toEqual({ n: 0 });
    const origins = await pool.query(
      'SELECT count(*)::int AS n FROM origin_fetch_state WHERE jsonb_array_length(leases) > 0',
    );
    expect(origins.rows[0]).toEqual({ n: 0 });
    const again = await prepareRecovery(pool);
    expect(again).toEqual({
      activeJobsRequeued: 0,
      activeJobsFailed: 0,
      outboxLeasesCleared: 0,
      originLeasesCleared: 0,
      analysisLeasesReset: 0,
      outboxPending: 3,
    });
    const analysis = await pool.query(
      'SELECT status, count(*)::int AS n, count(lease_token)::int AS leased FROM analysis_requests GROUP BY status',
    );
    expect(analysis.rows).toEqual([{ status: 'pending', n: 3, leased: 0 }]);
  });
});
