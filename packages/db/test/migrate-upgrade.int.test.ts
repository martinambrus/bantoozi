import { cp, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createCard,
  createFeed,
  createArticle,
  createSubscription,
  createUser,
  setupTestDatabase,
  type TestDatabase,
} from '@bantoozi/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrationStatus, readMigrationJournal } from '../src/readiness.js';
import { createDatabase } from '../src/client.js';
import { MIGRATIONS_FOLDER, PG_BOSS_VERSION, runMigrations } from '../src/migrate/migrate.js';
import { setupDbTest, type DbTestContext } from './support/test-db.js';

/**
 * Launch checklist item 12 (spec 11 §9): the upgrade path. A database at the previous release (every
 * bundled migration except the newest) holds representative data written through the real schema;
 * the real migrate job then applies the remaining migration(s). The data survives, the catalog
 * equals a freshly migrated database (and expected-schema.json), and readiness is green.
 */

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}
interface ExpectedSchema {
  tables: Record<string, unknown>;
  functions: Record<string, unknown>;
}

const expected = JSON.parse(
  readFileSync(new URL('./expected-schema.json', import.meta.url), 'utf8'),
) as ExpectedSchema;

/** A semantic fingerprint of the whole catalog (tables, columns, constraints, indexes, RLS, functions, triggers, grants). */
const CATALOG_QUERIES: Record<string, string> = {
  columns: `SELECT c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
                   || ' ' || a.attnotnull || ' ' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') || ' ' || a.attidentity::text AS v
              FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
              LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
             WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped ORDER BY 1`,
  constraints: `SELECT c.relname || ' ' || con.conname || ' ' || pg_get_constraintdef(con.oid) AS v
                  FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public' ORDER BY 1`,
  indexes: `SELECT indexdef AS v FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`,
  rls: `SELECT c.relname || ' ' || c.relrowsecurity || ' ' || c.relforcerowsecurity AS v
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r','p') ORDER BY 1`,
  policies: `SELECT tablename || ' ' || policyname || ' ' || cmd || ' ' || roles::text || ' '
                    || coalesce(qual, '') || ' ' || coalesce(with_check, '') AS v
               FROM pg_policies WHERE schemaname = 'public' ORDER BY 1`,
  functions: `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' || md5(pg_get_functiondef(p.oid))
                     || ' ' || coalesce(p.proacl::text, '') AS v
                FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public'
                 AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
               ORDER BY 1`,
  triggers: `SELECT c.relname || ' ' || md5(pg_get_triggerdef(t.oid)) || ' ' || t.tgname AS v
               FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND NOT t.tgisinternal ORDER BY 1`,
  tableGrants: `SELECT table_name || ' ' || grantee || ' ' || privilege_type AS v
                  FROM information_schema.role_table_grants
                 WHERE table_schema = 'public' AND grantee LIKE 'bantoozi_%' ORDER BY 1`,
  columnGrants: `SELECT table_name || '.' || column_name || ' ' || grantee || ' ' || privilege_type AS v
                   FROM information_schema.column_privileges
                  WHERE table_schema = 'public' AND grantee LIKE 'bantoozi_%' ORDER BY 1`,
  pgbossQueues: `SELECT name || ' ' || policy AS v FROM pgboss.queue ORDER BY 1`,
};

async function catalog(url: string): Promise<Record<string, string[]>> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const out: Record<string, string[]> = {};
    for (const [name, text] of Object.entries(CATALOG_QUERIES)) {
      const result = await client.query<{ v: string }>(text);
      out[name] = result.rows.map((r) => r.v);
    }
    return out;
  } finally {
    await client.end();
  }
}

let fresh: DbTestContext;
let previous: TestDatabase;
let folder: string;
let journal: { entries: JournalEntry[] };
let previousFolder: string;
let ownerPool: pg.Pool;

beforeAll(async () => {
  fresh = await setupDbTest();
  journal = JSON.parse(
    await readFile(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  ) as {
    entries: JournalEntry[];
  };
  // The folder of every migration but the newest, derived from the bundled journal.
  folder = await mkdtemp(path.join(tmpdir(), 'bantoozi-upgrade-'));
  previousFolder = folder;
  await mkdir(path.join(folder, 'meta'));
  const kept = journal.entries.slice(0, -1);
  for (const entry of kept) {
    await cp(
      path.join(MIGRATIONS_FOLDER, `${entry.tag}.sql`),
      path.join(folder, `${entry.tag}.sql`),
    );
  }
  await writeFile(
    path.join(folder, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries: kept }),
  );
  previous = await setupTestDatabase({
    pkg: 'dbup',
    migrationsDir: folder,
    pgBossVersion: PG_BOSS_VERSION,
    migrate: async (url) => {
      await runMigrations({ databaseUrl: url, migrationsFolder: folder });
    },
  });
  ownerPool = new pg.Pool({ connectionString: previous.urls.owner, max: 3 });
});

afterAll(async () => {
  await ownerPool?.end();
  await previous?.drop();
  await fresh?.close();
  if (previousFolder !== undefined) await rm(previousFolder, { recursive: true, force: true });
});

describe('upgrade from the previous release (spec 11 §9 item 12)', () => {
  it('keeps representative data intact and matches a fresh schema after the newest migration', async () => {
    const newest = journal.entries[journal.entries.length - 1]!;
    expect(journal.entries.length).toBeGreaterThan(1);

    // Before: the database is exactly one migration behind.
    const before = await ownerPool.query<{ n: number; latest: string }>(
      'SELECT count(*)::int AS n, max(created_at)::text AS latest FROM drizzle.__drizzle_migrations',
    );
    expect(before.rows[0]?.n).toBe(journal.entries.length - 1);
    expect(Number(before.rows[0]?.latest)).toBeLessThan(newest.when);

    // Representative data through the real schema of the previous release.
    const user = await createUser(ownerPool);
    const other = await createUser(ownerPool);
    const feed = await createFeed(ownerPool, { title: 'Upgrade feed' });
    await createSubscription(ownerPool, { userId: user.id, feedId: feed.id, mode: 'active' });
    const article = await createArticle(ownerPool, {
      feedIds: [feed.id],
      title: 'Upgrade article',
    });
    const card = await createCard(ownerPool, {
      title: 'Upgrade card',
      interest: 'Upgrade interest',
    });
    const snapshot = await ownerPool.query<{ id: string }>(
      `INSERT INTO article_snapshots (article_id, source_revision, source_url, title, body_text, body_html,
                                      content_sha256, completeness, source, extractor_version)
       VALUES ($1, 1, 'https://news.example.test/upgrade', 'Upgrade article', 'Upgrade text',
               '<p>Upgrade text</p>', repeat('d', 64), 'complete', 'page', 'extract-v1')
       RETURNING id::text AS id`,
      [article.id],
    );
    const snapshotId = snapshot.rows[0]!.id;
    await ownerPool.query(
      `INSERT INTO user_article (user_id, article_id, rating, reason, rated_at, bookmarked_at,
                                 bookmark_snapshot_id, bookmark_origin_feed_id, bookmark_capture_status)
       VALUES ($1, $2, -1, 'seen', now(), now(), $3, $4, 'saved')`,
      [user.id, article.id, snapshotId, feed.id],
    );
    await ownerPool.query(
      `INSERT INTO job_outbox (queue, payload, dedupe_key, user_id)
       VALUES ('user.rank', '{"userId":"${user.id}","full":true}'::jsonb, 'upgrade-intent', $1)`,
      [user.id],
    );
    // Engagement written before the newest migration: only an event, only reader state, a bulk read.
    const eventOnly = await createArticle(ownerPool, { feedIds: [feed.id], title: 'Event only' });
    const stateOnly = await createArticle(ownerPool, { feedIds: [feed.id], title: 'State only' });
    const bulkOnly = await createArticle(ownerPool, { feedIds: [feed.id], title: 'Bulk only' });
    await ownerPool.query(
      `INSERT INTO feedback_events (user_id, article_id, kind) VALUES ($1, $2, 'read'), ($1, $3, 'mark_read'), ($1, $3, 'unread')`,
      [user.id, eventOnly.id, bulkOnly.id],
    );
    await ownerPool.query(
      `INSERT INTO user_article (user_id, article_id, opened_at) VALUES ($1, $2, now())`,
      [user.id, stateOnly.id],
    );
    const counts = async () => {
      const result = await ownerPool.query<Record<string, string>>(
        `SELECT (SELECT count(*) FROM users WHERE id IN ($1, $2))::text AS users,
                (SELECT count(*) FROM subscriptions WHERE user_id = $1 AND feed_id = $3 AND inference_mode = 'active')::text AS subs,
                (SELECT count(*) FROM articles WHERE id = $4 AND title = 'Upgrade article')::text AS articles,
                (SELECT count(*) FROM user_article WHERE user_id = $1 AND article_id = $4 AND rating = -1
                    AND bookmark_snapshot_id = $5 AND bookmark_capture_status = 'saved')::text AS ratings,
                (SELECT count(*) FROM article_snapshots WHERE id = $5 AND content_sha256 = repeat('d', 64)
                    AND body_html = '<p>Upgrade text</p>')::text AS snapshots,
                (SELECT count(*) FROM interest_cards WHERE id = $6 AND title = 'Upgrade card')::text AS cards,
                (SELECT count(*) FROM job_outbox WHERE dedupe_key = 'upgrade-intent' AND delivered_at IS NULL)::text AS outbox`,
        [user.id, other.id, feed.id, article.id, snapshotId, card.id],
      );
      return result.rows[0];
    };
    const expectedCounts = {
      users: '2',
      subs: '1',
      articles: '1',
      ratings: '1',
      snapshots: '1',
      cards: '1',
      outbox: '1',
    };
    expect(await counts()).toEqual(expectedCounts);

    // The real migrate entry applies exactly the remaining migration.
    const result = await runMigrations({ databaseUrl: previous.urls.owner });
    expect(result.migrationsApplied).toBe(1);
    expect(result.pgBoss).toBe('current');

    // Data intact.
    expect(await counts()).toEqual(expectedCounts);

    // The migration marks the already-engaged articles (events, reader state), not a bulk read alone.
    const marked = await ownerPool.query<{ id: string; engaged: boolean }>(
      `SELECT a.id::text AS id, EXISTS (SELECT 1 FROM article_engagement e WHERE e.article_id = a.id) AS engaged
         FROM articles a WHERE a.id = ANY($1::bigint[]) ORDER BY a.id`,
      [[article.id, eventOnly.id, stateOnly.id, bulkOnly.id]],
    );
    expect(new Map(marked.rows.map((row) => [row.id, row.engaged]))).toEqual(
      new Map([
        [article.id, true],
        [eventOnly.id, true],
        [stateOnly.id, true],
        [bulkOnly.id, false],
      ]),
    );

    // Schema parity: the upgraded catalog equals a fresh database and expected-schema.json.
    const upgraded = await catalog(previous.urls.owner);
    const reference = await catalog(fresh.testDb.urls.owner);
    expect(upgraded).toEqual(reference);
    const tables = await ownerPool.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p') ORDER BY 1`,
    );
    expect(tables.rows.map((r) => r.relname)).toEqual(Object.keys(expected.tables).sort());
    const functions = await ownerPool.query<{ proname: string }>(
      `SELECT DISTINCT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
        ORDER BY 1`,
    );
    expect(functions.rows.map((r) => r.proname)).toEqual(Object.keys(expected.functions).sort());

    // Readiness is green for the API role, and a re-run applies nothing.
    const appPool = new pg.Pool({ connectionString: previous.urls.app, max: 1 });
    try {
      const bundled = readMigrationJournal(MIGRATIONS_FOLDER);
      await expect(migrationStatus(createDatabase(appPool), bundled)).resolves.toEqual({
        ready: true,
        expectedLatest: bundled.latestWhen,
        appliedLatest: bundled.latestWhen,
        newerApplied: 0,
      });
    } finally {
      await appPool.end();
    }
    await expect(runMigrations({ databaseUrl: previous.urls.owner })).resolves.toMatchObject({
      migrationsApplied: 0,
    });
  });
});
