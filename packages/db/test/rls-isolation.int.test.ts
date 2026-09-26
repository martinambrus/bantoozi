import { randomUUID } from 'node:crypto';

import { buildJobIntent } from '@bantoozi/shared';
import { cardTextHash, sha256Hex } from '@bantoozi/shared/server';
import {
  createArticle,
  createCard,
  createFeed,
  createSubscription,
  createUser,
  type Queryable,
} from '@bantoozi/testing';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type Executor } from '../src/client.js';
import { tenantOutbox } from '../src/outbox.js';
import { withTenant } from '../src/tenant.js';
import {
  asTenant,
  setupDbTest,
  sqlStateOf,
  withConnection,
  type DbTestContext,
} from './support/test-db.js';

/**
 * Tenant isolation with the real role logins (spec 02 §4, §5, §5.1, §8 item 2): every per-user
 * table fails closed without `app.user_id`, even on a reused connection; tenant A can neither read
 * nor write tenant B's rows; private cards, answers, saved snapshots and outbox intents stay private.
 */

interface Fixtures {
  a: string;
  b: string;
  feed: string;
  spareFeed: string;
  article: string;
  spareArticle: string;
  cards: {
    /** Shared interest card created by A, held by A and B. */
    shared: string;
    /** Shared interest card created by B. */
    sharedB: string;
    /** Shared interest card nobody holds. */
    spare: string;
    forkA: string;
    forkB: string;
    /** Shared label held by A and B. */
    label: string;
    spareLabel: string;
    labelB: string;
  };
  suggestSet: string;
  mutations: { a: string; b: string };
  snapshots: {
    bookmarkA: string;
    bookmarkB: string;
    pinA: string;
    expiredPinA: string;
    pinB: string;
    orphan: string;
  };
}

type Statement = [text: string, values: unknown[]];

interface PerUserTable {
  table: string;
  /** What bantoozi_app may do (spec 02 §1.2); everything else is denied with 42501. */
  may: { insert: boolean; update: boolean; delete: boolean };
  /** A new row owned by the given user, valid when that user is the tenant. */
  insert: (userId: string) => Statement;
  /** Changes the given user's rows (through API-writable columns where the API may update). */
  update: (userId: string) => Statement;
  /** How inserting B's row fails when it is not RLS WITH CHECK or a missing privilege. */
  foreignInsert?: { code: string; constraint: string };
}

const FORK_B_TITLE = 'Private fork of B';

const RLS_VIOLATION = {
  code: '42501',
  message: expect.stringContaining('violates row-level security policy'),
};
const PERMISSION_DENIED = { code: '42501', message: expect.stringContaining('permission denied') };

// input_sha / publication_sha are the hex sha256 of the jsonb text, as the 0004 triggers require.
const ANALYSIS_REQUEST_INSERT = `
  INSERT INTO analysis_requests (id, user_id, feed_id, article_id, article_revision, inference_version,
                                 input_snapshot, input_sha)
  SELECT $1::uuid, $2::uuid, $3::bigint, $4::bigint, 1, 1, s, encode(sha256(convert_to(s::text, 'UTF8')), 'hex')
    FROM (SELECT $5::jsonb AS s) AS input`;
const PUBLICATION_REQUEST_INSERT = `
  INSERT INTO card_publication_requests (user_id, card_id, card_text_hash, publication_payload, publication_sha)
  SELECT $1::uuid, $2::bigint, $3, p, encode(sha256(convert_to(p::text, 'UTF8')), 'hex')
    FROM (SELECT $4::jsonb AS p) AS proposal`;

let ctx: DbTestContext;
let f: Fixtures;
/** Every seeded per-user row as record text, per table and user (the byte-for-byte reference). */
const baseline = new Map<string, { a: string[]; b: string[] }>();
let cardsBaseline: string[];

/** The per-user tables of spec 02 §4, each with a sample insert and update. */
const PER_USER_TABLES: PerUserTable[] = [
  {
    table: 'subscriptions',
    may: { insert: true, update: true, delete: true },
    insert: (u) => [
      'INSERT INTO subscriptions (user_id, feed_id) VALUES ($1, $2)',
      [u, f.spareFeed],
    ],
    update: (u) => ["UPDATE subscriptions SET folder = 'moved' WHERE user_id = $1", [u]],
  },
  {
    table: 'user_feed_preferences',
    may: { insert: true, update: true, delete: true },
    insert: (u) => [
      "INSERT INTO user_feed_preferences (user_id, feed_id, image_policy) VALUES ($1, $2, 'block')",
      [u, f.spareFeed],
    ],
    update: (u) => [
      "UPDATE user_feed_preferences SET image_policy = 'inherit', updated_at = now() WHERE user_id = $1",
      [u],
    ],
  },
  {
    table: 'analysis_requests',
    may: { insert: true, update: false, delete: false },
    insert: (u) => [
      ANALYSIS_REQUEST_INSERT,
      [randomUUID(), u, f.feed, f.spareArticle, { article: f.spareArticle, reader: u }],
    ],
    update: (u) => [
      "UPDATE analysis_requests SET status = 'cancelled', completed_at = now() WHERE user_id = $1",
      [u],
    ],
    // Its BEFORE INSERT tenant check (spec 02 §5.2) fires before RLS WITH CHECK.
    foreignInsert: { code: '23514', constraint: 'analysis_requests_insert_check' },
  },
  {
    table: 'card_publication_requests',
    may: { insert: false, update: false, delete: false },
    insert: (u) => [
      PUBLICATION_REQUEST_INSERT,
      [u, f.cards.shared, sha256Hex('probe'), { title: 'Probe' }],
    ],
    update: (u) => [
      "UPDATE card_publication_requests SET status = 'expired' WHERE user_id = $1",
      [u],
    ],
  },
  {
    table: 'user_cards',
    may: { insert: true, update: true, delete: true },
    insert: (u) => [
      "INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, 'like')",
      [u, f.cards.spare],
    ],
    update: (u) => [
      "UPDATE user_cards SET strength = 'never', updated_at = now() WHERE user_id = $1",
      [u],
    ],
  },
  {
    table: 'user_labels',
    may: { insert: true, update: true, delete: true },
    insert: (u) => [
      "INSERT INTO user_labels (user_id, card_id, name) VALUES ($1, $2, 'Spare')",
      [u, f.cards.spareLabel],
    ],
    update: (u) => ["UPDATE user_labels SET color = 'red' WHERE user_id = $1", [u]],
  },
  {
    table: 'user_rules',
    may: { insert: true, update: true, delete: true },
    insert: (u) => [
      "INSERT INTO user_rules (user_id, kind, value) VALUES ($1, 'mute_keyword', 'probe')",
      [u],
    ],
    update: (u) => ["UPDATE user_rules SET value = 'changed' WHERE user_id = $1", [u]],
  },
  {
    table: 'user_article',
    may: { insert: true, update: true, delete: false },
    insert: (u) => [
      'INSERT INTO user_article (user_id, article_id, read_at) VALUES ($1, $2, now())',
      [u, f.spareArticle],
    ],
    update: (u) => [
      'UPDATE user_article SET read_at = NULL, state_version = state_version + 1 WHERE user_id = $1',
      [u],
    ],
  },
  {
    table: 'feedback_events',
    may: { insert: true, update: false, delete: false },
    insert: (u) => [
      "INSERT INTO feedback_events (user_id, article_id, kind) VALUES ($1, $2, 'open')",
      [u, f.article],
    ],
    update: (u) => ["UPDATE feedback_events SET kind = 'undo' WHERE user_id = $1", [u]],
  },
  {
    table: 'user_models',
    may: { insert: false, update: false, delete: false },
    insert: (u) => [
      `INSERT INTO user_models (user_id, version, feature_spec_sha, n_labels, n_pos, n_neg, weights,
                                intercept, scaler, calibration, metrics)
       VALUES ($1, 2, 'probe', 0, 0, 0, '{}', 0, '{}', '{}', '{}')`,
      [u],
    ],
    update: (u) => ['UPDATE user_models SET active = NOT active WHERE user_id = $1', [u]],
  },
  {
    table: 'api_mutations',
    may: { insert: true, update: true, delete: true },
    insert: (u) => [
      `INSERT INTO api_mutations (user_id, id, request_hash, route, status, response, expires_at)
       VALUES ($1, $2, 'probe', 'POST /api/v1/probe', 200, '{}', now() + interval '8 days')`,
      [u, randomUUID()],
    ],
    update: (u) => ['UPDATE api_mutations SET status = 409 WHERE user_id = $1', [u]],
  },
  {
    table: 'bookmark_snapshot_pins',
    may: { insert: true, update: false, delete: false },
    insert: (u) => [
      `INSERT INTO bookmark_snapshot_pins (user_id, mutation_id, snapshot_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '10 minutes')`,
      [u, u === f.a ? f.mutations.a : f.mutations.b, f.snapshots.orphan],
    ],
    update: (u) => [
      "UPDATE bookmark_snapshot_pins SET expires_at = now() + interval '1 day' WHERE user_id = $1",
      [u],
    ],
  },
  {
    table: 'card_suggestions',
    may: { insert: false, update: true, delete: false },
    insert: (u) => [
      `INSERT INTO card_suggestions (user_id, card_id, question_set_id, model_pin, score)
       VALUES ($1, $2, $3, 'probe', 0.5)`,
      [u, f.cards.shared, f.suggestSet],
    ],
    update: (u) => ['UPDATE card_suggestions SET dismissed_at = now() WHERE user_id = $1', [u]],
  },
];

beforeAll(async () => {
  ctx = await setupDbTest();
  f = await seed(ctx.owner);
  for (const { table } of PER_USER_TABLES) {
    baseline.set(table, {
      a: await rowsOf(ctx.owner, table, f.a),
      b: await rowsOf(ctx.owner, table, f.b),
    });
  }
  cardsBaseline = await rowsOf(ctx.owner, 'interest_cards');
});

afterAll(async () => {
  await ctx.close();
});

// ── Helpers ───────────────────────────────────────────────────────────────────────────────────────

function seeded(table: string): { a: string[]; b: string[] } {
  const rows = baseline.get(table);
  if (rows === undefined) throw new Error(`no baseline for ${table}`);
  return rows;
}

/** Rows of `table` visible to `db` (optionally only `userId`'s), as sorted record text. */
async function rowsOf(db: Queryable, table: string, userId?: string): Promise<string[]> {
  const result = await db.query<{ row: string }>(
    `SELECT t::text AS row FROM ${table} t${userId === undefined ? '' : ' WHERE t.user_id = $1'}`,
    userId === undefined ? [] : [userId],
  );
  return result.rows.map((r) => r.row).sort();
}

async function countOf(db: Queryable, table: string): Promise<number | undefined> {
  const result = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return result.rows[0]?.n;
}

/** Sorted `id` column of a query. */
async function ids(db: Queryable, text: string, values: unknown[] = []): Promise<string[]> {
  const result = await db.query<{ id: string }>(text, values);
  return result.rows.map((r) => r.id).sort();
}

const sorted = (values: string[]): string[] => [...values].sort();

const run = (db: Queryable, [text, values]: Statement) => db.query(text, values);

/** `fn` on one connection of `pool`, bound to `userId` (or no tenant), always rolled back. */
async function attempt<T>(
  pool: pg.Pool,
  userId: string | null,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return withConnection(pool, async (client) => {
    await client.query('BEGIN');
    try {
      if (userId !== null)
        await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
      return await fn(client);
    } finally {
      await client.query('ROLLBACK');
    }
  });
}

/** SQLSTATE, constraint and message of the error a promise rejects with. */
async function failureOf(
  promise: Promise<unknown>,
): Promise<{ code: unknown; constraint: unknown; message: unknown }> {
  try {
    await promise;
  } catch (error) {
    const { code, constraint, message } = error as Record<string, unknown>;
    return { code, constraint, message };
  }
  throw new Error('expected a database error');
}

/** Both tenants' rows of `table` are byte-for-byte as seeded. */
async function expectUnchanged(table: string): Promise<void> {
  const { a, b } = seeded(table);
  expect(await rowsOf(ctx.owner, table, f.b)).toEqual(b);
  expect(await rowsOf(ctx.owner, table, f.a)).toEqual(a);
}

// ── Fixtures (as bantoozi_owner, satisfying the FKs, CHECKs and 0004 triggers) ────────────────

async function seed(owner: pg.Pool): Promise<Fixtures> {
  const insertId = async (text: string, values: unknown[]): Promise<string> =>
    (await owner.query<{ id: string }>(text, values)).rows[0]!.id;

  const a = (await createUser(owner)).id;
  const b = (await createUser(owner)).id;
  const feed = (await createFeed(owner)).id;
  const spareFeed = (await createFeed(owner)).id;
  const article = (await createArticle(owner, { feedIds: [feed] })).id;
  const spareArticle = (await createArticle(owner, { feedIds: [feed] })).id;
  // Training at version 1: analysis requests need a live training/active subscription.
  for (const userId of [a, b]) {
    await createSubscription(owner, { userId, feedId: feed, mode: 'training' });
  }

  const matchSetSha = sha256Hex('match-rls-test');
  await owner.query(
    "INSERT INTO question_sets (kind, version, sha256, definition) VALUES ('match', 'match-rls-test', $1, '{}')",
    [matchSetSha],
  );
  const suggestSet = await insertId(
    `INSERT INTO question_sets (kind, version, sha256, definition)
     VALUES ('suggest', 'suggest-rls-test', $1, '{}') RETURNING id::text AS id`,
    [sha256Hex('suggest-rls-test')],
  );

  const shared = await createCard(owner, { visibility: 'shared', creatorUserId: a });
  const sharedB = await createCard(owner, { visibility: 'shared', creatorUserId: b });
  const spare = await createCard(owner, { visibility: 'shared' });
  const label = await createCard(owner, { kind: 'label', visibility: 'shared', creatorUserId: a });
  const spareLabel = await createCard(owner, { kind: 'label', visibility: 'shared' });
  const labelB = await createCard(owner, {
    kind: 'label',
    visibility: 'private',
    ownerUserId: b,
    title: 'Secret label of B',
  });
  const fork = (userId: string, title: string) =>
    insertId(
      `INSERT INTO interest_cards (kind, title, body, text_hash, origin, visibility, parent_card_id,
                                   owner_user_id, creator_user_id)
       VALUES ('interest', $1, $2, $3, 'fork', 'private', $4, $5, $5) RETURNING id::text AS id`,
      [
        title,
        { interest: `${title}: interest` },
        cardTextHash({
          kind: 'interest',
          title,
          interest: `${title}: interest`,
          visibility: 'private',
          owner_user_id: userId,
        }),
        shared.id,
        userId,
      ],
    );
  const forkA = await fork(a, 'Private fork of A');
  const forkB = await fork(b, FORK_B_TITLE);

  await owner.query(
    `INSERT INTO user_cards (user_id, card_id, strength, scope_feed_id)
     VALUES ($1, $3, 'like', NULL), ($1, $4, 'must', NULL), ($2, $3, 'love', $6), ($2, $5, 'must', NULL)`,
    [a, b, shared.id, forkA, forkB, feed],
  );
  await owner.query(
    `INSERT INTO user_labels (user_id, card_id, name, color)
     VALUES ($1, $3, 'Work', 'blue'), ($2, $3, 'Job', 'green'), ($2, $4, 'Secret', 'red')`,
    [a, b, label.id, labelB.id],
  );
  await owner.query(
    `INSERT INTO user_feed_preferences (user_id, feed_id, image_policy)
     VALUES ($1, $3, 'block'), ($2, $3, 'allow')`,
    [a, b, feed],
  );
  await owner.query(
    `INSERT INTO user_rules (user_id, kind, value)
     VALUES ($1, 'mute_keyword', 'crypto'), ($2, 'block_domain', 'example.org')`,
    [a, b],
  );

  const snapshot = (name: string) =>
    insertId(
      `INSERT INTO article_snapshots (article_id, source_revision, title, body_text, content_sha256,
                                      completeness, source, extractor_version)
       VALUES ($1, 1, $2, $3, $4, 'complete', 'page', 'rls-test') RETURNING id::text AS id`,
      [article, `Saved copy (${name})`, `Saved text of ${name}`, sha256Hex(name)],
    );
  const snapshots = {
    bookmarkA: await snapshot('bookmark A'),
    bookmarkB: await snapshot('bookmark B'),
    pinA: await snapshot('pin A'),
    expiredPinA: await snapshot('expired pin A'),
    pinB: await snapshot('pin B'),
    orphan: await snapshot('orphan'),
  };

  const bookmark = (userId: string, snapshotId: string, labelId: string, rating: 1 | -1) =>
    owner.query(
      `INSERT INTO user_article (user_id, article_id, lane, read_at, rating, rated_at, reason,
                                 bookmarked_at, bookmark_snapshot_id, bookmark_origin_feed_id,
                                 bookmark_capture_status, label_ids)
       VALUES ($1, $2, 'for_you', now(), $3, now(), $4, now(), $5, $6, 'saved', $7)`,
      [userId, article, rating, rating === -1 ? 'clickbait' : null, snapshotId, feed, [labelId]],
    );
  await bookmark(a, snapshots.bookmarkA, label.id, 1);
  await bookmark(b, snapshots.bookmarkB, labelB.id, -1);

  await owner.query(
    `INSERT INTO feedback_events (user_id, article_id, kind, value)
     VALUES ($1, $3, 'bookmark', '{}'), ($2, $3, 'rate', '{"rating": -1}')`,
    [a, b, article],
  );
  await owner.query(
    `INSERT INTO user_models (user_id, version, feature_spec_sha, n_labels, n_pos, n_neg, weights,
                              intercept, scaler, calibration, metrics, active)
     VALUES ($1, 1, 'features-v1', 20, 12, 8, '{"bias": 0.1}', 0.5, '{}', '{"a": 1, "b": 0}', '{"cv_auc": 0.7}', true),
            ($2, 1, 'features-v1', 30, 10, 20, '{"bias": -0.2}', 0.1, '{}', '{"a": 2, "b": 1}', '{"cv_auc": 0.8}', true)`,
    [a, b],
  );

  const mutations = { a: randomUUID(), b: randomUUID() };
  for (const [userId, id] of [
    [a, mutations.a],
    [b, mutations.b],
  ] as const) {
    await owner.query(
      `INSERT INTO api_mutations (user_id, id, request_hash, route, status, response, undo, expires_at)
       VALUES ($1, $2, $3, 'POST /api/v1/articles/:id/bookmark', 200, '{"ok": true}',
               '{"bookmarked_at": null}', now() + interval '8 days')`,
      [userId, id, sha256Hex(id)],
    );
  }
  await owner.query(
    `INSERT INTO bookmark_snapshot_pins (user_id, mutation_id, snapshot_id, expires_at)
     VALUES ($1, $2, $3, now() + interval '10 minutes'), ($1, $2, $4, now() - interval '1 minute'),
            ($5, $6, $7, now() + interval '10 minutes')`,
    [a, mutations.a, snapshots.pinA, snapshots.expiredPinA, b, mutations.b, snapshots.pinB],
  );
  await owner.query(
    `INSERT INTO card_suggestions (user_id, card_id, question_set_id, model_pin, score)
     VALUES ($1, $3, $4, 'jev-1', 0.9), ($2, $3, $4, 'jev-1', 0.4)`,
    [a, b, spare.id, suggestSet],
  );
  for (const [userId, card] of [
    [a, shared],
    [b, sharedB],
  ] as const) {
    await owner.query(PUBLICATION_REQUEST_INSERT, [
      userId,
      card.id,
      card.textHash,
      { slug: `card-${card.id}`, title: `Card ${card.id}` },
    ]);
  }
  // The insert trigger requires the row's own tenant even for the owner.
  for (const userId of [a, b]) {
    await asTenant(owner, userId, (client) =>
      client.query(ANALYSIS_REQUEST_INSERT, [
        randomUUID(),
        userId,
        feed,
        article,
        { article, reader: userId },
      ]),
    );
  }

  for (const cardId of [shared.id, forkA, forkB]) {
    await owner.query(
      `INSERT INTO card_answers (article_id, card_id, p, engine, question_set_sha, article_revision,
                                 state_sha256, card_input_sha256, state_variant)
       VALUES ($1, $2, 0.5, 'typesafe', $3, 1, $4, $5, 'native')`,
      [article, cardId, matchSetSha, sha256Hex('state'), sha256Hex(`card-input-${cardId}`)],
    );
  }
  await owner.query(
    'INSERT INTO feed_cards (feed_id, card_id, holders) VALUES ($1, $2, 2), ($1, $3, 1), ($1, $4, 1)',
    [feed, shared.id, forkA, forkB],
  );

  return {
    a,
    b,
    feed,
    spareFeed,
    article,
    spareArticle,
    cards: {
      shared: shared.id,
      sharedB: sharedB.id,
      spare: spare.id,
      forkA,
      forkB,
      label: label.id,
      spareLabel: spareLabel.id,
      labelB: labelB.id,
    },
    suggestSet,
    mutations,
    snapshots,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────────────────────

describe('test setup', () => {
  it('logs in with the real roles: only the API role is subject to RLS', async () => {
    const role = async (pool: pg.Pool) =>
      (
        await pool.query<{ role: string; bypass: boolean }>(
          'SELECT rolname AS role, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user',
        )
      ).rows[0];
    expect(await role(ctx.appPool)).toEqual({ role: 'bantoozi_app', bypass: false });
    expect(await role(ctx.workerPool)).toEqual({ role: 'bantoozi_worker', bypass: true });
    expect(await role(ctx.owner)).toEqual({ role: 'bantoozi_owner', bypass: true });
  });

  it('covers exactly the tables with a tenant policy, each with forced RLS', async () => {
    const policies = await ctx.owner.query<{ name: string; enabled: boolean; forced: boolean }>(
      `SELECT c.relname AS name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
         FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND p.polname = c.relname || '_tenant'
        ORDER BY c.relname`,
    );
    expect(policies.rows).toEqual(
      sorted(PER_USER_TABLES.map((t) => t.table)).map((name) => ({
        name,
        enabled: true,
        forced: true,
      })),
    );
  });
});

describe('per-user tables (spec 02 §4, §5)', () => {
  describe.each(PER_USER_TABLES)('$table', (t) => {
    it('returns no rows without app.user_id, on a fresh or a reused connection', async () => {
      const { a, b } = seeded(t.table);
      expect(a.length).toBeGreaterThan(0);
      expect(b.length).toBeGreaterThan(0);

      const fresh = new pg.Client({ connectionString: ctx.testDb.urls.app });
      await fresh.connect();
      try {
        expect(await countOf(fresh, t.table)).toBe(0);
      } finally {
        await fresh.end();
      }

      // The tenant setting is transaction-local: the same session sees nothing once it ends.
      const reused = await withConnection(ctx.appPool, async (client) => {
        const pid = async () =>
          (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
        const session = await pid();
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.user_id', $1, true)", [f.a]);
        const inCommitted = await countOf(client, t.table);
        await client.query('COMMIT');
        const afterCommit = await countOf(client, t.table);
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.user_id', $1, true)", [f.b]);
        const inRolledBack = await countOf(client, t.table);
        await client.query('ROLLBACK');
        const afterRollback = await countOf(client, t.table);
        return {
          inCommitted,
          afterCommit,
          inRolledBack,
          afterRollback,
          sameSession: (await pid()) === session,
        };
      });
      expect(reused).toEqual({
        inCommitted: a.length,
        afterCommit: 0,
        inRolledBack: b.length,
        afterRollback: 0,
        sameSession: true,
      });
    });

    it('shows each tenant exactly its own rows', async () => {
      const { a, b } = seeded(t.table);
      expect(await asTenant(ctx.appPool, f.a, (c) => rowsOf(c, t.table))).toEqual(a);
      expect(await asTenant(ctx.appPool, f.b, (c) => rowsOf(c, t.table))).toEqual(b);
      expect(await asTenant(ctx.appPool, f.a, (c) => rowsOf(c, t.table, f.b))).toEqual([]);
    });

    it("rejects A inserting B's row", async () => {
      const foreign = await failureOf(attempt(ctx.appPool, f.a, (c) => run(c, t.insert(f.b))));
      expect(foreign).toMatchObject(
        t.foreignInsert ?? (t.may.insert ? RLS_VIOLATION : PERMISSION_DENIED),
      );
      if (t.may.insert) {
        // The same row for A itself is accepted, so the rejection is the tenant boundary.
        const own = await attempt(ctx.appPool, f.a, (c) => run(c, t.insert(f.a)));
        expect(own.rowCount).toBe(1);
      } else {
        const own = await failureOf(attempt(ctx.appPool, f.a, (c) => run(c, t.insert(f.a))));
        expect(own).toMatchObject(PERMISSION_DENIED);
      }
      await expectUnchanged(t.table);
    });

    it("updates none of B's rows", async () => {
      if (t.may.update) {
        const foreign = await attempt(ctx.appPool, f.a, (c) => run(c, t.update(f.b)));
        expect(foreign.rowCount).toBe(0);
        const own = await attempt(ctx.appPool, f.a, (c) => run(c, t.update(f.a)));
        expect(own.rowCount).toBe(seeded(t.table).a.length);
      } else {
        for (const userId of [f.b, f.a]) {
          const denied = await failureOf(
            attempt(ctx.appPool, f.a, (c) => run(c, t.update(userId))),
          );
          expect(denied).toMatchObject(PERMISSION_DENIED);
        }
      }
      await expectUnchanged(t.table);
    });

    it("deletes none of B's rows", async () => {
      const remove = (userId: string): Statement => [
        `DELETE FROM ${t.table} WHERE user_id = $1`,
        [userId],
      ];
      if (t.may.delete) {
        const foreign = await attempt(ctx.appPool, f.a, (c) => run(c, remove(f.b)));
        expect(foreign.rowCount).toBe(0);
        const own = await attempt(ctx.appPool, f.a, (c) => run(c, remove(f.a)));
        expect(own.rowCount).toBe(seeded(t.table).a.length);
      } else {
        for (const userId of [f.b, f.a]) {
          const denied = await failureOf(attempt(ctx.appPool, f.a, (c) => run(c, remove(userId))));
          expect(denied).toMatchObject(PERMISSION_DENIED);
        }
      }
      await expectUnchanged(t.table);
    });
  });

  it('fails closed on the pooled connection a withTenant transaction released', async () => {
    const pool = new pg.Pool({ connectionString: ctx.testDb.urls.app, max: 1 });
    try {
      const db = createDatabase(pool);
      const counts = async (executor: Executor) => {
        const result: Record<string, number | undefined> = {};
        for (const { table } of PER_USER_TABLES) {
          const rows = await executor.execute<{ n: number }>(
            sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`,
          );
          result[table] = rows.rows[0]?.n;
        }
        const pid = await executor.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
        return { pid: pid.rows[0]?.pid, result };
      };
      const inside = await withTenant(db, f.a, (tx) => counts(tx));
      const after = await counts(db);
      expect(after.pid).toBe(inside.pid);
      expect(inside.result).toEqual(
        Object.fromEntries(PER_USER_TABLES.map(({ table }) => [table, seeded(table).a.length])),
      );
      expect(after.result).toEqual(
        Object.fromEntries(PER_USER_TABLES.map(({ table }) => [table, 0])),
      );
    } finally {
      await pool.end();
    }
  });
});

describe('shared tables with private material (spec 02 §5.1)', () => {
  describe('interest_cards', () => {
    const publicCards = () => [
      f.cards.shared,
      f.cards.sharedB,
      f.cards.spare,
      f.cards.label,
      f.cards.spareLabel,
    ];
    const cardInsert = (
      origin: string,
      visibility: string,
      ownerUserId: string | null,
      creatorUserId: string | null,
    ): Statement => [
      `INSERT INTO interest_cards (kind, title, body, text_hash, origin, visibility, owner_user_id,
                                   creator_user_id)
       VALUES ('interest', 'Probe card', '{"interest": "Probe interest"}', $1, $2, $3, $4, $5)`,
      [sha256Hex(randomUUID()), origin, visibility, ownerUserId, creatorUserId],
    ];

    it("hides B's private cards from A, and every private card without a tenant", async () => {
      const visible = (tenant: string | null) =>
        asTenant(ctx.appPool, tenant, (c) => ids(c, 'SELECT id::text AS id FROM interest_cards'));
      expect(await visible(f.a)).toEqual(sorted([...publicCards(), f.cards.forkA]));
      expect(await visible(f.b)).toEqual(sorted([...publicCards(), f.cards.forkB, f.cards.labelB]));
      expect(await visible(null)).toEqual(sorted(publicCards()));
    });

    it("updates none of B's private cards", async () => {
      const statements: Statement[] = [
        ['UPDATE interest_cards SET retired_at = now() WHERE id = $1', [f.cards.forkB]],
        ["UPDATE interest_cards SET title = 'Renamed by A' WHERE owner_user_id = $1", [f.b]],
        ['UPDATE interest_cards SET retired_at = NULL WHERE id = $1', [f.cards.labelB]],
      ];
      for (const statement of statements) {
        const result = await attempt(ctx.appPool, f.a, (c) => run(c, statement));
        expect(result.rowCount).toBe(0);
      }
      expect(await rowsOf(ctx.owner, 'interest_cards')).toEqual(cardsBaseline);
    });

    it("rejects cards A inserts in B's name (or a library card as a non-admin)", async () => {
      const denied = [
        cardInsert('user', 'shared', null, f.b),
        cardInsert('fork', 'private', f.b, f.b),
        cardInsert('fork', 'private', f.b, f.a),
        cardInsert('fork', 'private', f.a, f.b),
        cardInsert('library', 'public', null, null),
      ];
      for (const statement of denied) {
        const failure = await failureOf(attempt(ctx.appPool, f.a, (c) => run(c, statement)));
        expect(failure).toMatchObject(RLS_VIOLATION);
      }
      // A's own shared card and private fork are accepted, so the policy rejects the above.
      for (const statement of [
        cardInsert('user', 'shared', null, f.a),
        cardInsert('fork', 'private', f.a, f.a),
      ]) {
        const result = await attempt(ctx.appPool, f.a, (c) => run(c, statement));
        expect(result.rowCount).toBe(1);
      }
      expect(await rowsOf(ctx.owner, 'interest_cards')).toEqual(cardsBaseline);
    });
  });

  describe('card_answers', () => {
    it("hides answers on B's private fork while answers on shared cards stay visible", async () => {
      const answered = (tenant: string | null) =>
        asTenant(ctx.appPool, tenant, (c) =>
          ids(c, 'SELECT card_id::text AS id FROM card_answers'),
        );
      expect(await answered(f.a)).toEqual(sorted([f.cards.shared, f.cards.forkA]));
      expect(await answered(f.b)).toEqual(sorted([f.cards.shared, f.cards.forkB]));
      expect(await answered(null)).toEqual([f.cards.shared]);
    });
  });

  describe('article_snapshots', () => {
    it('shows A only snapshots bound to its bookmark or its unexpired pin', async () => {
      const s = f.snapshots;
      const visible = (tenant: string | null) =>
        asTenant(ctx.appPool, tenant, (c) =>
          ids(c, 'SELECT id::text AS id FROM article_snapshots'),
        );
      expect(await visible(f.a)).toEqual(sorted([s.bookmarkA, s.pinA]));
      expect(await visible(f.b)).toEqual(sorted([s.bookmarkB, s.pinB]));
      expect(await visible(null)).toEqual([]);
      // B's saved copy stays invisible even when A names its id.
      const named = await asTenant(ctx.appPool, f.a, (c) =>
        ids(c, 'SELECT id::text AS id FROM article_snapshots WHERE id = $1', [s.bookmarkB]),
      );
      expect(named).toEqual([]);
      expect(await countOf(ctx.owner, 'article_snapshots')).toBe(6);
    });
  });

  describe('job_outbox', () => {
    const intentFor = (userId: string) =>
      buildJobIntent('user.rank', { userId, reason: 'rls_isolation' });

    it('accepts the intent A enqueues for itself through tenantOutbox', async () => {
      await withTenant(ctx.app, f.a, (tx) => tenantOutbox(tx).enqueue(intentFor(f.a)));
      const stored = await ctx.owner.query(
        'SELECT queue, payload, user_id FROM job_outbox WHERE user_id = $1',
        [f.a],
      );
      expect(stored.rows).toEqual([
        { queue: 'user.rank', payload: { userId: f.a, reason: 'rls_isolation' }, user_id: f.a },
      ]);
    });

    it("rejects a raw intent in B's name, with no requester, or without a tenant", async () => {
      const cases: [tenant: string | null, requester: string | null][] = [
        [f.a, f.b],
        [f.a, null],
        [null, null],
        [null, f.a],
      ];
      for (const [tenant, requester] of cases) {
        const failure = await failureOf(
          attempt(ctx.appPool, tenant, (c) =>
            c.query(
              "INSERT INTO job_outbox (queue, payload, user_id) VALUES ('user.rank', $1, $2)",
              [{ userId: f.b, reason: 'rls_isolation' }, requester],
            ),
          ),
        );
        expect(failure).toMatchObject(RLS_VIOLATION);
      }
    });

    it('gives the API no read, update or delete access, not even through RETURNING', async () => {
      await withTenant(ctx.app, f.b, (tx) => tenantOutbox(tx).enqueue(intentFor(f.b)));
      const statements: Statement[] = [
        ['SELECT payload FROM job_outbox', []],
        ['UPDATE job_outbox SET attempts = attempts + 1', []],
        ['DELETE FROM job_outbox', []],
        [
          "INSERT INTO job_outbox (queue, payload, user_id) VALUES ('user.rank', '{}', $1) RETURNING id",
          [f.a],
        ],
      ];
      for (const statement of statements) {
        const failure = await failureOf(attempt(ctx.appPool, f.a, (c) => run(c, statement)));
        expect(failure).toMatchObject(PERMISSION_DENIED);
      }
      const workerView = await ctx.workerPool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM job_outbox WHERE user_id = $1',
        [f.b],
      );
      expect(workerView.rows[0]?.n).toBe(1);
    });
  });
});

describe("acceptance: B's private cards and labels (spec 02 §8 item 2)", () => {
  it("rejects A attaching B's private card, even through the worker", async () => {
    const holding = { code: '23514', constraint: 'user_cards_card_check' };
    const attach: Statement = [
      "INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, 'like')",
      [f.a, f.cards.forkB],
    ];
    const inserted = await failureOf(attempt(ctx.appPool, f.a, (c) => run(c, attach)));
    expect(inserted).toMatchObject(holding);
    expect(inserted.message).not.toContain(FORK_B_TITLE);
    const repointed = await failureOf(
      attempt(ctx.appPool, f.a, (c) =>
        c.query('UPDATE user_cards SET card_id = $2 WHERE user_id = $1 AND card_id = $3', [
          f.a,
          f.cards.forkB,
          f.cards.shared,
        ]),
      ),
    );
    expect(repointed).toMatchObject(holding);
    // The trigger checks actual ownership for BYPASSRLS writers too (spec 02 §5.2).
    expect(await failureOf(attempt(ctx.workerPool, null, (c) => run(c, attach)))).toMatchObject(
      holding,
    );
    const suggested = await failureOf(
      attempt(ctx.workerPool, null, (c) =>
        c.query(
          `INSERT INTO card_suggestions (user_id, card_id, question_set_id, model_pin, score)
           VALUES ($1, $2, $3, 'jev-1', 0.5)`,
          [f.a, f.cards.forkB, f.suggestSet],
        ),
      ),
    );
    expect(suggested).toMatchObject({ code: '23514', constraint: 'card_suggestions_card_check' });
    await expectUnchanged('user_cards');
    await expectUnchanged('card_suggestions');
  });

  it("rejects A assigning B's private label", async () => {
    const held = await failureOf(
      attempt(ctx.appPool, f.a, (c) =>
        c.query("INSERT INTO user_labels (user_id, card_id, name) VALUES ($1, $2, 'Stolen')", [
          f.a,
          f.cards.labelB,
        ]),
      ),
    );
    expect(held).toMatchObject({ code: '23514', constraint: 'user_labels_card_check' });
    // Assigning it to A's article fails when the deferred label check runs at COMMIT.
    const assigned = await failureOf(
      asTenant(ctx.appPool, f.a, (c) =>
        c.query(
          `UPDATE user_article SET label_ids = ARRAY[$2::bigint], state_version = state_version + 1
            WHERE user_id = $1 AND article_id = $3`,
          [f.a, f.cards.labelB, f.article],
        ),
      ),
    );
    expect(assigned).toMatchObject({ code: '23514', constraint: 'user_article_labels_check' });
    await expectUnchanged('user_labels');
    await expectUnchanged('user_article');
  });

  it("gives A no join path to B's private fork", async () => {
    const joined = await asTenant(ctx.appPool, f.a, async (c) => ({
      holdings: await ids(
        c,
        'SELECT ic.id::text AS id FROM user_cards uc JOIN interest_cards ic ON ic.id = uc.card_id',
      ),
      forks: await ids(
        c,
        `SELECT child.id::text AS id FROM interest_cards parent
           JOIN interest_cards child ON child.parent_card_id = parent.id`,
      ),
      answersWithoutCard: await ids(
        c,
        `SELECT ca.card_id::text AS id FROM card_answers ca
           LEFT JOIN interest_cards ic ON ic.id = ca.card_id WHERE ic.id IS NULL`,
      ),
      holdersOfForkB: await ids(
        c,
        'SELECT user_id::text AS id FROM user_cards WHERE card_id = $1',
        [f.cards.forkB],
      ),
    }));
    expect(joined).toEqual({
      holdings: sorted([f.cards.shared, f.cards.forkA]),
      forks: [f.cards.forkA],
      answersWithoutCard: [],
      holdersOfForkB: [],
    });
    // The worker-only demand cache, which lists B's fork, is not readable at all.
    const demand = asTenant(ctx.appPool, f.a, (c) =>
      c.query('SELECT ic.id FROM feed_cards fc JOIN interest_cards ic ON ic.id = fc.card_id'),
    );
    expect(await sqlStateOf(demand)).toBe('42501');
  });

  it('stops non-admin A from renaming, rewriting or promoting a shared card', async () => {
    const renamed = await failureOf(
      attempt(ctx.appPool, f.a, (c) =>
        c.query("UPDATE interest_cards SET title = 'Renamed by A' WHERE id = $1", [f.cards.shared]),
      ),
    );
    expect(renamed).toMatchObject({ code: '23514', constraint: 'interest_cards_guard' });
    const outOfGrant: Statement[] = [
      [
        `UPDATE interest_cards SET body = body || '{"interest": "rewritten"}' WHERE id = $1`,
        [f.cards.shared],
      ],
      ["UPDATE interest_cards SET visibility = 'public' WHERE id = $1", [f.cards.shared]],
    ];
    for (const statement of outOfGrant) {
      const failure = await failureOf(attempt(ctx.appPool, f.a, (c) => run(c, statement)));
      expect(failure).toMatchObject(PERMISSION_DENIED);
    }
    expect(await rowsOf(ctx.owner, 'interest_cards')).toEqual(cardsBaseline);
  });

  it.each([
    'job_outbox',
    'match_queue',
    'feed_cards',
    'engine_calls',
    'engine_reservations',
    'provider_credentials',
    'pgboss.job',
  ])('keeps %s unreadable for the API role', async (table) => {
    const failure = await failureOf(
      asTenant(ctx.appPool, f.a, (c) => c.query(`SELECT * FROM ${table} LIMIT 1`)),
    );
    expect(failure).toMatchObject(PERMISSION_DENIED);
  });
});

describe('worker role (BYPASSRLS)', () => {
  it.each(PER_USER_TABLES)("sees both tenants' rows of $table", async ({ table }) => {
    const { a, b } = seeded(table);
    expect(await rowsOf(ctx.workerPool, table, f.a)).toEqual(a);
    expect(await rowsOf(ctx.workerPool, table, f.b)).toEqual(b);
  });

  it('sees every private card, answer, snapshot and demand row', async () => {
    const c = f.cards;
    expect(await ids(ctx.workerPool, 'SELECT id::text AS id FROM interest_cards')).toEqual(
      sorted([c.shared, c.sharedB, c.spare, c.label, c.spareLabel, c.forkA, c.forkB, c.labelB]),
    );
    expect(await ids(ctx.workerPool, 'SELECT card_id::text AS id FROM card_answers')).toEqual(
      sorted([c.shared, c.forkA, c.forkB]),
    );
    expect(await countOf(ctx.workerPool, 'article_snapshots')).toBe(6);
    expect(await ids(ctx.workerPool, 'SELECT card_id::text AS id FROM feed_cards')).toEqual(
      sorted([c.shared, c.forkA, c.forkB]),
    );
  });
});
