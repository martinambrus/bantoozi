import { createArticle, createCard, createFeed, createUser } from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sqlState } from '../../src/errors.js';
import { EVAL_USER_EMAIL, ensureEvalUser, evalUserId, isGoldenDatabase } from '../../src/index.js';
import { setupDbTest, type DbTestContext } from '../support/test-db.js';

/**
 * M3a-T1 (spec 02 §7, §8 case 7; D-96): the eval schema, its grants, the append-only dataset rules
 * and the evaluation system user, with real role logins.
 */

let ctx: DbTestContext;

async function failure(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return sqlState(error) ?? String(error);
  }
}

beforeAll(async () => {
  ctx = await setupDbTest();
});

afterAll(async () => {
  await ctx?.close();
});

describe('eval schema (M3a-T1)', () => {
  it('grants the worker role every eval table and the API role none', async () => {
    const tables = await ctx.owner.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'eval' ORDER BY 1`,
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual([
      'assignments',
      'datasets',
      'facet_labels',
      'rater_cards',
      'rater_feeds',
      'rater_sessions',
      'raters',
      'ratings',
      'run_answers',
      'runs',
      'sample',
    ]);
    for (const { table_name } of tables.rows) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        const worker = await ctx.owner.query<{ ok: boolean }>(
          `SELECT has_table_privilege('bantoozi_worker', $1, $2) AS ok`,
          [`eval.${table_name}`, privilege],
        );
        expect(worker.rows[0]!.ok, `${privilege} eval.${table_name}`).toBe(true);
        const app = await ctx.owner.query<{ ok: boolean }>(
          `SELECT has_table_privilege('bantoozi_app', $1, $2) AS ok`,
          [`eval.${table_name}`, privilege],
        );
        expect(app.rows[0]!.ok, `app ${privilege} eval.${table_name}`).toBe(false);
      }
    }
    expect(await failure(ctx.appPool.query('SELECT 1 FROM eval.raters'))).toBe('42501');
    const sequences = await ctx.owner.query<{ ok: boolean }>(
      `SELECT bool_and(has_sequence_privilege('bantoozi_worker', c.oid, 'USAGE')) AS ok
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'eval' AND c.relkind = 'S'`,
    );
    expect(sequences.rows[0]!.ok).toBe(true);
  });

  it('keeps one answer per run/article/card/question, NULL card ids included', async () => {
    const feed = await createFeed(ctx.owner);
    const article = await createArticle(ctx.owner, { feedIds: [feed.id] });
    await ctx.workerPool.query(
      `INSERT INTO eval.datasets (version, seed, params) VALUES ('answers-v1', 's', '{}')`,
    );
    const run = await ctx.workerPool.query<{ id: string }>(
      `INSERT INTO eval.runs (experiment, dataset_version, config, git_sha)
       VALUES ('E1', 'answers-v1', '{}', 'abc') RETURNING id::text AS id`,
    );
    const insert = () =>
      ctx.workerPool.query(
        `INSERT INTO eval.run_answers (run_id, article_id, card_id, question_key, answer)
         VALUES ($1, $2, NULL, 'clickbait', '{"p":0.1}')`,
        [run.rows[0]!.id, article.id],
      );
    await insert();
    expect(await failure(insert())).toBe('23505');
    // A resumed run upserts instead of duplicating.
    await ctx.workerPool.query(
      `INSERT INTO eval.run_answers (run_id, article_id, card_id, question_key, answer)
       VALUES ($1, $2, NULL, 'clickbait', '{"p":0.2}')
       ON CONFLICT (run_id, article_id, card_id, question_key) DO UPDATE SET answer = EXCLUDED.answer`,
      [run.rows[0]!.id, article.id],
    );
    const rows = await ctx.workerPool.query<{ answer: unknown }>(
      'SELECT answer FROM eval.run_answers WHERE run_id = $1',
      [run.rows[0]!.id],
    );
    expect(rows.rows).toEqual([{ answer: { p: 0.2 } }]);
    // A run's identity and configuration are immutable; its completion is recorded later.
    expect(
      await failure(
        ctx.workerPool.query(`UPDATE eval.runs SET config = '{"x":1}' WHERE id = $1`, [
          run.rows[0]!.id,
        ]),
      ),
    ).toBe('23514');
    await ctx.workerPool.query(
      `UPDATE eval.runs SET finished_at = now(), results = '{"status":"complete"}' WHERE id = $1`,
      [run.rows[0]!.id],
    );
  });

  it('keeps dataset versions append-only: immutable snapshots and frozen versions', async () => {
    const feed = await createFeed(ctx.owner);
    const a = await createArticle(ctx.owner, { feedIds: [feed.id] });
    const b = await createArticle(ctx.owner, { feedIds: [feed.id] });
    await ctx.workerPool.query(
      `INSERT INTO eval.datasets (version, seed, params) VALUES ('golden-t1', 'seed', '{}')`,
    );
    const sample = (version: string, articleId: string) =>
      ctx.workerPool.query(
        `INSERT INTO eval.sample (dataset_version, article_id, lang, snapshot, snapshot_sha, split)
         VALUES ($1, $2, 'en', '{"title":"t"}', 'sha', 'dev')`,
        [version, articleId],
      );
    await sample('golden-t1', a.id);
    expect(
      await failure(
        ctx.workerPool.query(`UPDATE eval.sample SET split = 'test' WHERE article_id = $1`, [a.id]),
      ),
    ).toBe('23514');
    expect(
      await failure(ctx.workerPool.query('DELETE FROM eval.sample WHERE article_id = $1', [a.id])),
    ).toBe('23514');
    // Freezing (the first run) closes the version: a top-up needs the next version.
    await ctx.workerPool.query(
      `UPDATE eval.datasets SET frozen_at = now(), manifest = '{}', snapshot_sha = 's', split_sha = 'p'
        WHERE version = 'golden-t1'`,
    );
    expect(await failure(sample('golden-t1', b.id))).toBe('23514');
    expect(
      await failure(
        ctx.workerPool.query(
          `UPDATE eval.datasets SET params = '{"x":1}' WHERE version = 'golden-t1'`,
        ),
      ),
    ).toBe('23514');
    expect(
      await failure(ctx.workerPool.query(`DELETE FROM eval.datasets WHERE version = 'golden-t1'`)),
    ).toBe('23514');
    await ctx.workerPool.query(
      `INSERT INTO eval.datasets (version, parent_version, seed, params)
       VALUES ('golden-t2', 'golden-t1', 'seed', '{}')`,
    );
    await sample('golden-t2', a.id);
    await sample('golden-t2', b.id);
    const counts = await ctx.workerPool.query<{ dataset_version: string; n: number }>(
      `SELECT dataset_version, count(*)::int AS n FROM eval.sample
        WHERE dataset_version LIKE 'golden-t%' GROUP BY 1 ORDER BY 1`,
    );
    expect(counts.rows).toEqual([
      { dataset_version: 'golden-t1', n: 1 },
      { dataset_version: 'golden-t2', n: 2 },
    ]);
    // A partial freeze is impossible: the manifest and its hashes arrive together.
    expect(
      await failure(
        ctx.workerPool.query(
          `UPDATE eval.datasets SET frozen_at = now() WHERE version = 'golden-t2'`,
        ),
      ),
    ).toBe('23514');
  });

  it('protects referenced articles, cards and feeds from deletion', async () => {
    const feed = await createFeed(ctx.owner);
    const article = await createArticle(ctx.owner, { feedIds: [feed.id] });
    const user = await createUser(ctx.owner);
    const card = await createCard(ctx.owner, { creatorUserId: user.id });
    const rater = await ctx.workerPool.query<{ id: string }>(
      `INSERT INTO eval.raters (name, participant_key, token_hash, token_expires_at, langs)
       VALUES ('owner', gen_random_uuid(), 'protect-token', now() + interval '30 days', '{sk,en}')
       RETURNING id::text AS id`,
    );
    const raterId = rater.rows[0]!.id;
    await ctx.workerPool.query(
      `INSERT INTO eval.rater_cards (rater_id, card_id, strength) VALUES ($1, $2, 'love')`,
      [raterId, card.id],
    );
    await ctx.workerPool.query('INSERT INTO eval.rater_feeds (rater_id, feed_id) VALUES ($1, $2)', [
      raterId,
      feed.id,
    ]);
    await ctx.workerPool.query(
      'INSERT INTO eval.ratings (rater_id, article_id, rating) VALUES ($1, $2, 1)',
      [raterId, article.id],
    );
    expect(await failure(ctx.owner.query('DELETE FROM articles WHERE id = $1', [article.id]))).toBe(
      '23503',
    );
    expect(
      await failure(ctx.owner.query('DELETE FROM interest_cards WHERE id = $1', [card.id])),
    ).toBe('23503');
    expect(await failure(ctx.owner.query('DELETE FROM feeds WHERE id = $1', [feed.id]))).toBe(
      '23503',
    );
    // Deleting the rater cascades to its own rows only.
    await ctx.workerPool.query('DELETE FROM eval.raters WHERE id = $1', [raterId]);
    const left = await ctx.owner.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM eval.rater_cards WHERE rater_id = $1)
            + (SELECT count(*) FROM eval.ratings WHERE rater_id = $1) AS n`,
      [raterId],
    );
    expect(Number(left.rows[0]!.n)).toBe(0);
  });
});

describe('evaluation system user (M3a-T1)', () => {
  it('creates eval@bantoozi.local once, as a plain user without invites, and marks the golden database', async () => {
    expect(await isGoldenDatabase(ctx.worker)).toBe(false);
    const first = await ctx.worker.transaction((tx) => ensureEvalUser(tx));
    const second = await ctx.worker.transaction((tx) => ensureEvalUser(tx));
    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });
    expect(await evalUserId(ctx.worker)).toBe(first.id);
    expect(await isGoldenDatabase(ctx.worker)).toBe(true);
    const row = await ctx.owner.query<{ role: string; invites_left: number }>(
      'SELECT role, invites_left FROM users WHERE email = $1',
      [EVAL_USER_EMAIL],
    );
    expect(row.rows).toEqual([{ role: 'user', invites_left: 0 }]);
  });
});
