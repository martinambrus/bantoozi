import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setupDbTest, withConnection, type DbTestContext } from './support/test-db.js';

/**
 * Migration 0019: indexes for the retention purges and FK cascades (spec 11 §5-6). Every referencing
 * lookup of a delete (article, feed, card, user) must be served by an index, not a table scan.
 */

interface Spec {
  name: string;
  schema: 'public' | 'eval';
  table: string;
  /** Exact column list inside the parentheses of the index definition. */
  columns: string;
  /** Exact partial-index predicate, or null for a full index. */
  where: string | null;
}

const p = (
  table: string,
  columns: string,
  where: string | null = null,
  schema: 'public' | 'eval' = 'public',
): Spec => ({
  name: `${table}_${columns.replace(/, /g, '_')}_idx`,
  schema,
  table,
  columns,
  where,
});

const INDEXES: Spec[] = [
  p('user_article', 'article_id'),
  p('user_article', 'bookmark_snapshot_id', 'bookmark_snapshot_id IS NOT NULL'),
  p('user_article', 'bookmark_origin_feed_id', 'bookmark_origin_feed_id IS NOT NULL'),
  p('user_article', 'next_rank_at', 'next_rank_at IS NOT NULL'),
  {
    ...p('user_article', 'article_id', "bookmark_capture_status = 'pending'::text"),
    name: 'user_article_pending_capture_idx',
  },
  p('feedback_events', 'article_id'),
  p('article_aliases', 'article_id'),
  p('analysis_requests', 'article_id'),
  p('analysis_requests', 'feed_id'),
  p('story_clusters', 'representative_article_id'),
  { ...p('story_clusters', 'id', 'size = 0'), name: 'story_clusters_empty_idx' },
  p('bookmark_snapshot_pins', 'snapshot_id'),
  p('user_feed_preferences', 'feed_id'),
  p('feeds', 'merged_into_id', 'merged_into_id IS NOT NULL'),
  p('feed_cards', 'card_id'),
  p('match_queue', 'card_id'),
  p('card_suggestions', 'card_id'),
  p('user_labels', 'card_id'),
  p('interest_cards', 'parent_card_id', 'parent_card_id IS NOT NULL'),
  p('card_publication_requests', 'card_id'),
  p('engine_calls', 'user_id'),
  p('engine_reservations', 'expires_at', "status = 'reserved'::text"),
  {
    ...p('article_bodies', 'extracted_at', 'body_text IS NOT NULL OR body_html IS NOT NULL'),
    name: 'article_bodies_extracted_idx',
  },
  p('job_outbox', 'delivered_at', 'delivered_at IS NOT NULL'),
  p('sample', 'article_id', null, 'eval'),
  p('assignments', 'article_id', null, 'eval'),
  p('ratings', 'article_id', null, 'eval'),
  p('run_answers', 'article_id', null, 'eval'),
  p('run_answers', 'card_id', null, 'eval'),
  p('rater_cards', 'card_id', null, 'eval'),
  p('rater_feeds', 'feed_id', null, 'eval'),
];

let ctx: DbTestContext;

beforeAll(async () => {
  ctx = await setupDbTest();
});

afterAll(async () => {
  await ctx.close();
});

const normalize = (s: string): string => s.replace(/[()]/g, '').replace(/\s+/g, ' ').trim();

describe('migration 0019 purge indexes', () => {
  it.each(INDEXES)('has index $name', async (spec) => {
    const { rows } = await ctx.owner.query<{ def: string }>(
      `SELECT indexdef AS def FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 AND indexname = $3`,
      [spec.schema, spec.table, spec.name],
    );
    expect(rows).toHaveLength(1);
    const def = rows[0]!.def;
    expect(def).toMatch(/USING btree/);
    expect(def).not.toMatch(/CREATE UNIQUE/);
    const cols = /USING btree \(([^)]*)\)/.exec(def)?.[1];
    expect(cols).toBe(spec.columns);
    const where = /\bWHERE (.*)$/.exec(def)?.[1] ?? null;
    expect(where === null ? null : normalize(where)).toBe(
      spec.where === null ? null : normalize(spec.where),
    );
  });

  const usedIndexes = (node: unknown, acc: string[] = []): string[] => {
    if (node !== null && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === 'Index Name' && typeof v === 'string') acc.push(v);
        else usedIndexes(v, acc);
      }
    }
    return acc;
  };

  it.each([
    [
      'delete an article: user_article rows',
      'user_article',
      'article_id',
      'user_article_article_id_idx',
    ],
    ['delete a card: label rows', 'user_labels', 'card_id', 'user_labels_card_id_idx'],
    [
      'delete a feed: preference rows',
      'user_feed_preferences',
      'feed_id',
      'user_feed_preferences_feed_id_idx',
    ],
  ])('cascade lookup (%s) is an index scan on the new index', async (_label, table, col, idx) => {
    const id = 1;
    const plan = await withConnection(ctx.owner, async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('SET LOCAL enable_seqscan = off');
        const r = await c.query<{ 'QUERY PLAN': unknown }>(
          `EXPLAIN (FORMAT JSON) SELECT 1 FROM ${table} WHERE ${col} = $1`,
          [id],
        );
        return r.rows[0]!['QUERY PLAN'];
      } finally {
        await c.query('ROLLBACK');
      }
    });
    const text = JSON.stringify(plan);
    expect(text).toMatch(/Index|Bitmap/);
    expect(usedIndexes(plan)).toContain(idx);
  });
});
