import { readFileSync } from 'node:fs';
import { createFeed, createSubscription, createUser, type Queryable } from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../src/client.js';
import { ensureDevUser } from '../src/ingest/dev-cli.js';
import { ensureEvalUser } from '../src/eval/system-user.js';

import { setupDbTest, type DbTestContext } from './support/test-db.js';

/**
 * Editable plans in the database (D-255, docs/design/plan-velocity.md §6): the `plans` table and
 * its seed, `users.plan` referencing it, and `refresh_feed_subscribers(bigint[])` taking the fetch
 * interval floor from the stored plans instead of a jsonb map.
 */

let ctx: DbTestContext;

beforeAll(async () => {
  ctx = await setupDbTest();
});

afterAll(async () => {
  await ctx.close();
});

let seq = 0;

interface PlanRow {
  key: string;
  label: string;
  label_sk: string | null;
  max_feeds: number;
  max_cards: number;
  max_labels: number;
  max_forks: number;
  max_rules: number;
  opml_max_feeds: number;
  min_fetch_interval_s: number;
  release_interval_s: number | null;
  backfill_days: number;
  invites_on_signup: number;
  sort_order: number;
  is_default: boolean;
  retired_at: Date | null;
  version: number | string;
}

async function plan(key: string): Promise<PlanRow | undefined> {
  const result = await ctx.owner.query<PlanRow>('SELECT * FROM plans WHERE key = $1', [key]);
  return result.rows[0];
}

/** A plan row with `beta`'s limits except for the given overrides (owner connection). */
async function insertPlan(
  db: Queryable,
  over: Partial<Record<string, string | number | boolean | null>> = {},
): Promise<string> {
  seq += 1;
  const row = {
    key: `t${seq}-${Math.random().toString(36).slice(2, 8)}`,
    label: 'Test plan',
    label_sk: 'Testovací plán',
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
    sort_order: 100 + seq,
    is_default: false,
    ...over,
  };
  const columns = Object.keys(row);
  await db.query(
    `INSERT INTO plans (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(row),
  );
  return row.key as string;
}

async function counters(feedId: string) {
  const result = await ctx.owner.query<{ subscriber_count: number; min_interval_s: number }>(
    'SELECT subscriber_count, min_interval_s FROM feeds WHERE id = $1',
    [feedId],
  );
  return result.rows[0];
}

describe('plans table and seed', () => {
  it('seeds beta/admin allowances and their approved release cadences', async () => {
    expect(await plan('beta')).toMatchObject({
      max_feeds: 200,
      max_cards: 150,
      max_labels: 20,
      max_forks: 20,
      max_rules: 200,
      opml_max_feeds: 300,
      min_fetch_interval_s: 900,
      release_interval_s: 900,
      backfill_days: 7,
      invites_on_signup: 3,
      is_default: true,
      retired_at: null,
    });
    expect(await plan('admin')).toMatchObject({
      max_feeds: 2000,
      max_cards: 500,
      max_labels: 200,
      max_forks: 200,
      max_rules: 2000,
      opml_max_feeds: 2000,
      min_fetch_interval_s: 300,
      release_interval_s: 300,
      backfill_days: 14,
      invites_on_signup: 50,
      is_default: false,
    });
  });

  it('seeds the tiers free, basic, plus, pro, max and premium with their fetch intervals', async () => {
    const result = await ctx.owner.query<{
      key: string;
      min_fetch_interval_s: number;
      release_interval_s: number;
    }>(
      `SELECT key, min_fetch_interval_s, release_interval_s FROM plans
        WHERE key IN ('free', 'basic', 'plus', 'pro', 'max', 'premium')`,
    );
    expect(Object.fromEntries(result.rows.map((r) => [r.key, r.min_fetch_interval_s]))).toEqual({
      free: 21600,
      basic: 3600,
      plus: 1800,
      pro: 600,
      max: 300,
      premium: 60,
    });
  });

  it('seeds each paid/free release cadence to match its approved fetch interval', async () => {
    const result = await ctx.owner.query<{ key: string }>(
      "SELECT key FROM plans WHERE key IN ('free','basic','plus','pro','max','premium') AND release_interval_s IS DISTINCT FROM min_fetch_interval_s",
    );
    expect(result.rows).toEqual([]);
  });

  it('accepts immediate or 60..86400-second releases and rejects invalid boundaries', async () => {
    for (const release_interval_s of [1, 59, 86401]) {
      await expect(insertPlan(ctx.owner, { release_interval_s })).rejects.toMatchObject({
        code: '23514',
      });
    }
    for (const release_interval_s of [null, 0, 60, 86400])
      await insertPlan(ctx.owner, { release_interval_s });
  });

  it('has exactly one default plan, beta, and every plan has a label and a sort order', async () => {
    const defaults = await ctx.owner.query<{ key: string }>(
      'SELECT key FROM plans WHERE is_default',
    );
    expect(defaults.rows.map((r) => r.key)).toEqual(['beta']);
    const unlabeled = await ctx.owner.query(
      `SELECT key FROM plans WHERE coalesce(label, '') = '' OR sort_order IS NULL`,
    );
    expect(unlabeled.rows).toEqual([]);
  });

  it('refuses a second default plan', async () => {
    await expect(insertPlan(ctx.owner, { is_default: true })).rejects.toMatchObject({
      code: '23505',
    });
  });

  it('keeps the fetch interval between 60 and 86400 seconds', async () => {
    await expect(insertPlan(ctx.owner, { min_fetch_interval_s: 59 })).rejects.toMatchObject({
      code: '23514',
    });
    await expect(insertPlan(ctx.owner, { min_fetch_interval_s: 86401 })).rejects.toMatchObject({
      code: '23514',
    });
    await insertPlan(ctx.owner, { min_fetch_interval_s: 60 });
    await insertPlan(ctx.owner, { min_fetch_interval_s: 86400 });
  });

  it('refuses a negative limit', async () => {
    await expect(insertPlan(ctx.owner, { max_feeds: -1 })).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('starts a plan at version 1 with no retirement', async () => {
    const key = await insertPlan(ctx.owner);
    expect(await plan(key)).toMatchObject({ retired_at: null, is_default: false });
    expect(Number((await plan(key))!.version)).toBe(1);
  });
});

describe('users.plan references plans', () => {
  it('refuses a user on an unknown plan', async () => {
    await expect(createUser(ctx.owner, { plan: 'no-such-plan' })).rejects.toMatchObject({
      code: '23503',
    });
  });

  it('accepts a user on a stored plan, and the plan in use cannot be deleted', async () => {
    const key = await insertPlan(ctx.owner);
    const user = await createUser(ctx.owner, { plan: key });
    await expect(ctx.owner.query('DELETE FROM plans WHERE key = $1', [key])).rejects.toMatchObject({
      code: '23503',
    });
    await ctx.owner.query('UPDATE users SET plan = $2 WHERE id = $1', [user.id, 'beta']);
    await ctx.owner.query('DELETE FROM plans WHERE key = $1', [key]);
    expect(await plan(key)).toBeUndefined();
  });

  it('gives a user inserted without a plan the beta plan', async () => {
    const id = '0192f7a0-0000-7000-8000-0000000000e1';
    await ctx.owner.query(
      `INSERT INTO users (id, email) VALUES ($1, 'default-plan@example.test')`,
      [id],
    );
    const result = await ctx.owner.query<{ plan: string }>('SELECT plan FROM users WHERE id = $1', [
      id,
    ]);
    expect(result.rows[0]?.plan).toBe('beta');
  });
});

describe('refresh_feed_subscribers(bigint[]) reads the floor from plans', () => {
  it('uses the stored plan interval of the fastest subscriber, with no jsonb map', async () => {
    const slow = await insertPlan(ctx.owner, { min_fetch_interval_s: 3600 });
    const fast = await insertPlan(ctx.owner, { min_fetch_interval_s: 120 });
    const feed = await createFeed(ctx.owner);
    const a = await createUser(ctx.owner, { plan: slow });
    const b = await createUser(ctx.owner, { plan: fast });
    await createSubscription(ctx.owner, { userId: a.id, feedId: feed.id, mode: 'active' });
    await createSubscription(ctx.owner, { userId: b.id, feedId: feed.id, mode: 'active' });
    await ctx.workerPool.query('SELECT refresh_feed_subscribers($1::bigint[])', [[feed.id]]);
    expect(await counters(feed.id)).toEqual({ subscriber_count: 2, min_interval_s: 120 });

    await ctx.owner.query('DELETE FROM subscriptions WHERE user_id = $1', [b.id]);
    await ctx.workerPool.query('SELECT refresh_feed_subscribers($1::bigint[])', [[feed.id]]);
    expect(await counters(feed.id)).toEqual({ subscriber_count: 1, min_interval_s: 3600 });
  });

  it('follows an edited plan interval on the next refresh, with no code change', async () => {
    const key = await insertPlan(ctx.owner, { min_fetch_interval_s: 900 });
    const feed = await createFeed(ctx.owner);
    const user = await createUser(ctx.owner, { plan: key });
    await createSubscription(ctx.owner, { userId: user.id, feedId: feed.id, mode: 'active' });
    await ctx.workerPool.query('SELECT refresh_feed_subscribers($1::bigint[])', [[feed.id]]);
    expect((await counters(feed.id))?.min_interval_s).toBe(900);
    await ctx.owner.query('UPDATE plans SET min_fetch_interval_s = 450 WHERE key = $1', [key]);
    await ctx.workerPool.query('SELECT refresh_feed_subscribers($1::bigint[])', [[feed.id]]);
    expect((await counters(feed.id))?.min_interval_s).toBe(450);
  });

  it('falls back to 900 seconds for a feed without subscribers', async () => {
    const feed = await createFeed(ctx.owner);
    await ctx.owner.query('UPDATE feeds SET min_interval_s = 60 WHERE id = $1', [feed.id]);
    await ctx.workerPool.query('SELECT refresh_feed_subscribers($1::bigint[])', [[feed.id]]);
    expect(await counters(feed.id)).toEqual({ subscriber_count: 0, min_interval_s: 900 });
  });

  it('no longer has the two-argument jsonb form', async () => {
    const result = await ctx.owner.query<{ args: string }>(
      `SELECT pg_get_function_identity_arguments(p.oid) AS args
         FROM pg_proc p WHERE p.proname = 'refresh_feed_subscribers'`,
    );
    expect(result.rows.map((r) => r.args)).toEqual(['p_feed_ids bigint[]']);
  });
});

describe('non-HTTP account creation uses the stored default', () => {
  it('creates development and evaluation accounts on the chosen plan', async () => {
    const key = await insertPlan(ctx.owner, { invites_on_signup: 17 });
    await ctx.owner.query('UPDATE plans SET is_default = false WHERE is_default');
    await ctx.owner.query('UPDATE plans SET is_default = true WHERE key = $1', [key]);
    try {
      const db = createDatabase(ctx.workerPool);
      const dev = await db.transaction((tx) => ensureDevUser(tx, `dev-${key}@example.test`));
      const evaluation = await db.transaction((tx) => ensureEvalUser(tx));
      const rows = await ctx.owner.query(
        'SELECT id::text, plan, invites_left FROM users WHERE id = ANY($1::uuid[])',
        [[dev.id, evaluation.id]],
      );
      expect(rows.rows).toEqual(
        expect.arrayContaining([
          { id: dev.id, plan: key, invites_left: 17 },
          { id: evaluation.id, plan: key, invites_left: 0 },
        ]),
      );
    } finally {
      await ctx.owner.query('UPDATE plans SET is_default = false WHERE is_default');
      await ctx.owner.query("UPDATE plans SET is_default = true WHERE key = 'beta'");
    }
  });
});

it('restores the smoke administrator when beta was deleted and another plan is the default', async () => {
  const client = await ctx.owner.connect();
  try {
    await client.query('BEGIN');
    const key = await insertPlan(client);
    await client.query('UPDATE plans SET is_default = false WHERE is_default');
    await client.query('UPDATE plans SET is_default = true WHERE key = $1', [key]);
    await client.query("UPDATE users SET plan = $1 WHERE plan = 'beta'", [key]);
    await client.query("DELETE FROM plans WHERE key = 'beta'");
    const script = readFileSync(
      new URL('../../../infra/scripts/restore-test.sh', import.meta.url),
      'utf8',
    );
    const smokeInsert = script.match(/^insert into users[\s\S]*?;/im)?.[0];
    expect(smokeInsert).toBeDefined();
    await client.query(smokeInsert!.replace(":'email'", '$1'), ['smoke-plan@example.test']);
    const restored = await client.query(
      "SELECT role, plan FROM users WHERE email = 'smoke-plan@example.test'",
    );
    expect(restored.rows).toEqual([{ role: 'admin', plan: key }]);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
