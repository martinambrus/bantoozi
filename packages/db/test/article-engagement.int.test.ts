import { createArticle, createFeed, createUser } from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setupDbTest, type DbTestContext } from './support/test-db.js';

/**
 * The engagement marker (D-253, Codex r2b): the trigger on `feedback_events` records the first
 * engagement per article in `article_engagement` without a lock stronger than the reader actions'
 * own `FOR SHARE` on the article row.
 */

let ctx: DbTestContext;

beforeAll(async () => {
  ctx = await setupDbTest();
});

afterAll(async () => {
  await ctx.close();
});

describe('article_engagement marker', () => {
  it('two reader actions holding FOR SHARE on one article both commit, with one marker row', async () => {
    const feed = await createFeed(ctx.owner);
    const article = await createArticle(ctx.owner, { feedIds: [feed.id], title: 'Shared' });
    const alice = await createUser(ctx.owner);
    const bob = await createUser(ctx.owner);
    const a = await ctx.owner.connect();
    const b = await ctx.owner.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      await a.query('SELECT 1 FROM articles WHERE id = $1 FOR SHARE', [article.id]);
      await b.query('SELECT 1 FROM articles WHERE id = $1 FOR SHARE', [article.id]);
      const insert = (client: typeof a, userId: string, kind: string) =>
        client.query(
          'INSERT INTO feedback_events (user_id, article_id, kind) VALUES ($1, $2, $3)',
          [userId, article.id, kind],
        );
      // Both inserts start while both transactions hold FOR SHARE. A marker insert may wait for the
      // other transaction to finish (same primary key); that is a plain wait, not a deadlock, so each
      // side commits as soon as its own insert returns.
      const run = async (client: typeof a, userId: string, kind: string) => {
        try {
          await insert(client, userId, kind);
          await client.query('COMMIT');
          return 'committed';
        } catch (error) {
          return String(error);
        }
      };
      const results = await Promise.all([run(a, alice.id, 'open'), run(b, bob.id, 'rate')]);
      expect(results).toEqual(['committed', 'committed']);
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      a.release();
      b.release();
    }
    const rows = await ctx.owner.query(
      'SELECT article_id::text FROM article_engagement WHERE article_id = $1',
      [article.id],
    );
    expect(rows.rows).toHaveLength(1);
  });
});
