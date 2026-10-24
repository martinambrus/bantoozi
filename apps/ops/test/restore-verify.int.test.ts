import {
  MIGRATIONS_FOLDER,
  PG_BOSS_CRON_QUEUE,
  PG_BOSS_VERSION,
  runMigrations,
} from '@bantoozi/db';
import { ProviderKeyring, encryptProviderSecret } from '@bantoozi/shared/server/credential-crypto';
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

import {
  VerifyError,
  checkBounds,
  checkColdBookmarks,
  checkForeignKeys,
  checkProviderCredentials,
  checkRoles,
  checkRowLevelSecurity,
  checkSchema,
  checkSequences,
  checkActiveSets,
  verifyRestore,
} from '../src/restore-verify.js';

/**
 * The restore verification (spec 11 §4) against a migrated database standing in for the throwaway
 * restore: every check passes on a healthy copy and fails, naming the check, when its subject is
 * damaged. The connection is the superuser of the test cluster, as in the throwaway instance.
 */

const KEY_ID = 'k1';
const KEYS = JSON.stringify({ k1: Buffer.alloc(32, 7).toString('base64') });
const WRONG_KEYS = JSON.stringify({ k1: Buffer.alloc(32, 8).toString('base64') });
const SECRET = 'tsk-restore-test-provider-key-0001';

let testDb: TestDatabase;
let pool: pg.Pool;
let snapshotSha: string;

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
  const alice = await createUser(pool, { email: 'alice@example.test' });
  const feed = await createFeed(pool);
  const article = await createArticle(pool, { feedIds: [feed.id], title: 'Gone story' });
  const html = '<p>Plná <b>správa</b> o tom, ako sa vec stala.</p>'.repeat(2000);
  const text = 'Plná správa o tom, ako sa vec stala. The quick brown fox. '.repeat(2000);
  const snap = await pool.query<{ id: string; sha: string }>(
    `INSERT INTO article_snapshots (article_id, source_revision, captured_at, source_url, title, author,
                                    published_at, body_text, body_html, content_sha256, completeness, source,
                                    extractor_version, cold_at)
     SELECT a.id, 1, now() - interval '40 days', a.url, a.title, 'Reporter', a.published_at, $2, $3,
            snapshot_content_sha256(a.title, 'Reporter', a.published_at, a.url, $2, $3), 'complete', 'page',
            'ops-test', now()
       FROM articles a WHERE a.id = $1
     RETURNING id::text AS id, content_sha256 AS sha`,
    [article.id, text, html],
  );
  snapshotSha = snap.rows[0]!.sha;
  await pool.query(
    `INSERT INTO user_article (user_id, article_id, bookmarked_at, bookmark_snapshot_id, bookmark_origin_feed_id,
                               bookmark_capture_status)
     VALUES ($1, $2, now() - interval '40 days', $3, $4, 'saved')`,
    [alice.id, article.id, snap.rows[0]!.id, feed.id],
  );
  const parsed = ProviderKeyring.parse(KEY_ID, KEYS);
  if (!parsed.ok) throw new Error('test keyring');
  const envelope = encryptProviderSecret({
    keyring: parsed.keyring,
    provider: 'typesafe',
    secretVersion: '1',
    secret: SECRET,
  });
  await pool.query(
    `INSERT INTO provider_credentials (provider, revision, active_version, active_envelope, enabled, activated_at)
     VALUES ('typesafe', 1, 1, $1::jsonb, true, now())`,
    [JSON.stringify(envelope)],
  );
});

afterAll(async () => {
  await pool.end();
  await dropCreatedTestDatabases();
});

describe('restore verification on a healthy restore', () => {
  it('reports every check and the checksum of the cold bookmarked snapshot', async () => {
    const lines = await verifyRestore(pool, {
      bounds: { users: 1, user_article: 1 },
      keys: { keyId: KEY_ID, keysJson: KEYS },
    });
    const version = Number(
      (await pool.query('SELECT count(*) AS n FROM drizzle.__drizzle_migrations')).rows[0].n,
    );
    expect(lines).toContain(`SCHEMA_VERSION=${version}`);
    expect(lines.join('\n')).toMatch(/CHECK foreign_keys=ok/u);
    expect(lines.join('\n')).toMatch(/CHECK rls=ok/u);
    expect(lines.join('\n')).toMatch(/CHECK roles=ok/u);
    expect(lines.join('\n')).toMatch(/CHECK queues=ok/u);
    expect(lines).toContain(
      `cold bookmark snapshot verified match content_sha256=${snapshotSha} refetch=0`,
    );
    expect(lines).toContain('PROVIDER_CREDENTIAL typesafe version=1 decrypt=ok fake_provider=ok');
    expect(lines.join('\n')).not.toContain(SECRET);
    expect(lines.join('\n')).not.toContain('alice@example.test');
  });

  it('leaves no fixture behind (the row-level security check rolls back)', async () => {
    await checkRowLevelSecurity(pool);
    const left = await pool.query(
      "SELECT count(*) AS n FROM users WHERE email LIKE '%restore-fixture.invalid'",
    );
    expect(Number(left.rows[0].n)).toBe(0);
  });
});

describe('restore verification on a damaged restore', () => {
  it.each(['user.estimate', PG_BOSS_CRON_QUEUE])('fails naming missing queue %s', async (queue) => {
    await pool.query('DELETE FROM pgboss.job WHERE name = $1', [queue]);
    await pool.query('SELECT pgboss.delete_queue($1)', [queue]);
    try {
      await expect(
        verifyRestore(pool, { keys: { keyId: KEY_ID, keysJson: KEYS } }),
      ).rejects.toThrow(new RegExp(`check queues failed:.*${queue}.*migrate`, 'u'));
    } finally {
      await runMigrations({ databaseUrl: testDb.urls.owner });
    }
  });

  it('fails the migration count when it differs from the manifest', async () => {
    await expect(checkSchema(pool, 1)).rejects.toThrow(/migrations/u);
  });

  it('fails a bound the manifest recorded far from the restored count', async () => {
    await expect(checkBounds(pool, { users: 500 })).rejects.toThrow(/bounds/u);
    await expect(checkBounds(pool, { 'users; drop table users': 1 })).rejects.toThrow(
      /invalid table/u,
    );
  });

  it('fails when the provider key was recovered wrongly or not at all', async () => {
    await expect(
      checkProviderCredentials(pool, { keyId: KEY_ID, keysJson: WRONG_KEYS }),
    ).rejects.toThrow(/does not decrypt/u);
    await expect(
      checkProviderCredentials(pool, { keyId: undefined, keysJson: undefined }),
    ).rejects.toThrow(/master keys unavailable/u);
  });

  it('fails a snapshot whose text no longer matches its checksum', async () => {
    await pool.query('ALTER TABLE article_snapshots DISABLE TRIGGER USER');
    try {
      await pool.query("UPDATE article_snapshots SET body_text = body_text || ' tampered'");
      await expect(checkColdBookmarks(pool)).rejects.toThrow(/no longer matches its checksum/u);
    } finally {
      await pool.query(
        `UPDATE article_snapshots s SET body_text = replace(body_text, ' tampered', '')`,
      );
      await pool.query('ALTER TABLE article_snapshots ENABLE TRIGGER USER');
    }
    await expect(checkColdBookmarks(pool)).resolves.toBeDefined();
  });

  it('fails a sequence that is behind the data', async () => {
    await pool.query(
      `INSERT INTO question_sets (id, kind, version, sha256, definition)
       OVERRIDING SYSTEM VALUE VALUES (900000, 'enrich', 'seq-test', 'seq-test-sha', '{}')`,
    );
    try {
      await expect(checkSequences(pool)).rejects.toThrow(/sequences/u);
    } finally {
      await pool.query("DELETE FROM question_sets WHERE version = 'seq-test'");
    }
    await expect(checkSequences(pool)).resolves.toBeDefined();
  });

  it('fails an active question set that does not exist', async () => {
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('question_sets.active', '{"enrich": 987654}'::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    try {
      await expect(checkActiveSets(pool)).rejects.toThrow(/active_sets|active enrich/u);
    } finally {
      await pool.query("DELETE FROM settings WHERE key = 'question_sets.active'");
    }
  });

  it('fails a missing role and a non-validated foreign key', async () => {
    await expect(checkRoles(pool)).resolves.toBeDefined();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `ALTER TABLE subscriptions ADD CONSTRAINT fk_unvalidated FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID`,
      );
      await expect(
        client.query(
          "SELECT count(*) FROM pg_constraint WHERE conname = 'fk_unvalidated' AND NOT convalidated",
        ),
      ).resolves.toMatchObject({ rows: [{ count: '1' }] });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    await expect(checkForeignKeys(pool)).resolves.toBeDefined();
  });

  it('reports VerifyError with the failing check name', async () => {
    const error = await checkBounds(pool, { users: 500 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VerifyError);
    expect((error as VerifyError).check).toBe('bounds');
  });
});
