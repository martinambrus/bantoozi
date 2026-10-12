import { createUser } from '@bantoozi/testing';
import type { SQL } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Transaction } from '../../src/client.js';
import { archiveOverCapItems, UNREAD_CAP, usersOverUnreadCap } from '../../src/house/archive.js';
import { render, inlineParams, type RenderedQuery } from '../support/s19-explain.js';
import { setupDbTest, type DbTestContext } from '../support/test-db.js';

/**
 * M8-F6: the unread-cap queries of `house.archive` (spec 11 §5, §6) must be served by an index on
 * `user_article` (a fixture large enough that a sequential scan is the wrong plan is analyzed, and
 * EXPLAIN of the exact statements the functions issue is read), and a deleted user (`deleted_at`
 * set) is never archived. Migration 0023 is expected to add a partial index on
 * `user_article (user_id, article_id) WHERE read_at IS NULL AND archived_at IS NULL` (name free;
 * the assertions below look at the plan, not at the name).
 */

let ctx: DbTestContext;
let heavyUser: string;
let deletedUser: string;
const NOW = new Date('2026-10-12T03:15:00.000Z');
const HEAVY_ARTICLES = UNREAD_CAP + 400;

beforeAll(async () => {
  ctx = await setupDbTest();
  const heavy = await createUser(ctx.owner, {});
  const gone = await createUser(ctx.owner, {});
  heavyUser = heavy.id;
  deletedUser = gone.id;
  const fillers: string[] = [];
  for (let i = 0; i < 40; i += 1) fillers.push((await createUser(ctx.owner, {})).id);
  const owners = [heavyUser, deletedUser, ...fillers];

  // One feed per user. The two cap users carry HEAVY_ARTICLES articles each; fillers carry 400.
  for (const [i, userId] of owners.entries()) {
    const articles = i < 2 ? HEAVY_ARTICLES : 400;
    const feed = await ctx.owner.query<{ id: string }>(
      `INSERT INTO feeds (url, fetch_url, title, status)
       VALUES ($1, $1, 'Cap feed', 'active') RETURNING id::text AS id`,
      [`https://cap.example.test/${i}.xml`],
    );
    const feedId = feed.rows[0]!.id;
    await ctx.owner.query(
      `INSERT INTO subscriptions (user_id, feed_id, inference_mode, inference_version)
       VALUES ($1, $2, 'off', 0)`,
      [userId, feedId],
    );
    await ctx.owner.query(
      `INSERT INTO articles (url, canonical_url, url_key, title, title_norm, first_seen_at,
                             content_hash, pipeline_state)
       SELECT 'https://cap.example.test/a/' || $1 || '/' || g,
              'https://cap.example.test/a/' || $1 || '/' || g,
              'cap.example.test/a/' || $1 || '/' || g, 'Cap ' || g, 'cap ' || g,
              $3::timestamptz - make_interval(secs => g * 60),
              encode(sha256(convert_to($1 || 'x' || g, 'UTF8')), 'hex'), 'enriched'
         FROM generate_series(1, $2::int) g`,
      [String(i), articles, NOW.toISOString()],
    );
    await ctx.owner.query(
      `INSERT INTO feed_items (feed_id, article_id, guid, first_seen_at)
       SELECT $1, a.id, 'g' || a.id, a.first_seen_at FROM articles a
        WHERE a.url_key LIKE 'cap.example.test/a/' || $2 || '/%'`,
      [feedId, String(i)],
    );
    await ctx.owner.query(
      `INSERT INTO user_article (user_id, article_id, lane, tier, score_source, rank_revision)
       SELECT $1, a.id, 'new', 1, 'none', 0 FROM articles a
        WHERE a.url_key LIKE 'cap.example.test/a/' || $2 || '/%'`,
      [userId, String(i)],
    );
  }
  await ctx.owner.query(`UPDATE users SET deleted_at = $2 WHERE id = $1`, [
    deletedUser,
    NOW.toISOString(),
  ]);
  await ctx.owner.query('ANALYZE');
});

afterAll(async () => {
  await ctx?.close();
});

/** The statement a house function issues, recorded through a stand-in transaction. */
async function captured(fn: (tx: Transaction) => Promise<unknown>): Promise<RenderedQuery> {
  const seen: RenderedQuery[] = [];
  const tx = {
    execute: async (query: SQL) => {
      seen.push(render(query));
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Transaction;
  await fn(tx);
  const last = seen.at(-1);
  if (last === undefined) throw new Error('no statement was issued');
  return last;
}

interface PlanNode {
  'Node Type'?: string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}

function nodes(node: PlanNode, acc: PlanNode[] = []): PlanNode[] {
  acc.push(node);
  for (const child of node.Plans ?? []) nodes(child, acc);
  return acc;
}

async function planOf(query: RenderedQuery): Promise<PlanNode[]> {
  const result = await ctx.owner.query<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(
    `EXPLAIN (FORMAT JSON) ${inlineParams(query)}`,
  );
  return nodes(result.rows[0]!['QUERY PLAN'][0]!.Plan);
}

/** user_article scans of a plan: `Seq Scan` is the failure, the index scans must name an index. */
function userArticleScans(plan: PlanNode[]): PlanNode[] {
  return plan.filter(
    (n) => n['Relation Name'] === 'user_article' && /Scan/u.test(n['Node Type'] ?? ''),
  );
}

describe('house.archive unread-cap queries (M8-F6)', () => {
  it('has a fixture of the shape the plan check is meant for', async () => {
    const count = await ctx.owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM user_article WHERE read_at IS NULL AND archived_at IS NULL`,
    );
    expect(count.rows[0]?.n).toBeGreaterThan(2 * HEAVY_ARTICLES);
  });

  it('usersOverUnreadCap reads user_article through an index, never a sequential scan', async () => {
    const query = await captured((tx) => usersOverUnreadCap(tx, { after: null, limit: 100 }));
    const scans = userArticleScans(await planOf(query));
    expect(scans.length).toBeGreaterThan(0);
    expect(scans.filter((n) => n['Node Type'] === 'Seq Scan')).toEqual([]);
  });

  it('archiveOverCapItems of one user reads the unread rows through a partial unread index (user_id, article_id), not the lane index or a scan', async () => {
    const query = await captured((tx) =>
      archiveOverCapItems(tx, { userId: heavyUser, now: NOW, limit: 500 }),
    );
    const scans = userArticleScans(await planOf(query));
    expect(scans.length).toBeGreaterThan(0);
    expect(scans.filter((n) => n['Node Type'] === 'Seq Scan')).toEqual([]);
    // The index serving the cap query is a dedicated one, not the reader-list lane index.
    const names = scans.map((n) => n['Index Name']).filter((n): n is string => n !== undefined);
    expect(names.some((name) => /(unread|cap)/u.test(name))).toBe(true);
  });

  it('a deleted user is not listed as over the cap and none of their items is archived', async () => {
    const listed: string[] = [];
    let after: string | null = null;
    for (;;) {
      const page: string[] = await ctx.worker.transaction((tx) =>
        usersOverUnreadCap(tx, { after, limit: 100 }),
      );
      if (page.length === 0) break;
      listed.push(...page);
      after = page.at(-1) ?? null;
    }
    expect(listed).toContain(heavyUser);
    expect(listed).not.toContain(deletedUser);

    const archived = await ctx.worker.transaction((tx) =>
      archiveOverCapItems(tx, { userId: deletedUser, now: NOW, limit: 5_000 }),
    );
    expect(archived).toBe(0);
    const rows = await ctx.owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM user_article WHERE user_id = $1 AND archived_at IS NOT NULL`,
      [deletedUser],
    );
    expect(rows.rows[0]?.n).toBe(0);
  });

  it('an active user over the cap still has exactly the items beyond the cap archived', async () => {
    const archived = await ctx.worker.transaction((tx) =>
      archiveOverCapItems(tx, { userId: heavyUser, now: NOW, limit: 5_000 }),
    );
    expect(archived).toBe(HEAVY_ARTICLES - UNREAD_CAP);
  });
});
