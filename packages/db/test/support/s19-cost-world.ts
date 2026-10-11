import { createUser } from '@bantoozi/testing';
import type pg from 'pg';

/**
 * S19 cost fixture: one reader with 64 subscriptions (40 active, 12 training with selected
 * analysis requests, 12 off, a few hidden), ~2,400 articles inside the 14-day rank window and 1,200
 * older ones, shared carriage, folded clusters, stored rankings and read state, plus three filler
 * readers so the shared tables are not single-tenant. Everything is generated in SQL (deterministic
 * through `setseed`), then ANALYZEd, so the plans are the ones a real database would pick.
 */

export const COST_WINDOW_ARTICLES = 2400;
export const COST_OLD_ARTICLES = 1200;
export const COST_FEEDS = 64;
export const COST_SCORE_VERSION = '1:0';

export interface CostWorld {
  userId: string;
  asOf: Date;
  feedCount: number;
  windowArticles: number;
}

export async function buildCostWorld(owner: pg.Pool, asOf: Date = new Date()): Promise<CostWorld> {
  const user = await createUser(owner, {});
  const fillers = [];
  for (let i = 0; i < 3; i += 1) fillers.push(await createUser(owner, {}));
  const at = asOf.toISOString();

  await owner.query(`SELECT setseed(0.19)`);
  await owner.query(
    `INSERT INTO feeds (url, fetch_url, title, status)
     SELECT 'https://cost.example.test/' || g || '.xml', 'https://cost.example.test/' || g || '.xml',
            'Cost feed ' || g, 'active'
       FROM generate_series(1, $1::int) g`,
    [COST_FEEDS],
  );
  const feeds = await owner.query<{ id: string }>(`SELECT id::text FROM feeds ORDER BY id`);
  if (feeds.rows.length !== COST_FEEDS) throw new Error('the cost fixture needs an empty database');

  // 1..40 active, 41..52 training, 53..64 off; four hidden, six allowing duplicates.
  await owner.query(
    `INSERT INTO subscriptions (user_id, feed_id, inference_mode, inference_version,
                                inference_activated_at, hidden, allow_duplicates, folder)
     SELECT $1, f.id,
            CASE WHEN f.rn <= 40 THEN 'active' WHEN f.rn <= 52 THEN 'training' ELSE 'off' END,
            CASE WHEN f.rn <= 52 THEN 1 ELSE 0 END,
            CASE WHEN f.rn <= 40 THEN $2::timestamptz - interval '40 days' END,
            f.rn IN (7, 19, 45, 60), f.rn % 11 = 0,
            CASE WHEN f.rn % 8 = 0 THEN 'folder-' || (f.rn % 3) END
       FROM (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM feeds) f`,
    [user.id, at],
  );
  for (const filler of fillers) {
    await owner.query(
      `INSERT INTO subscriptions (user_id, feed_id, inference_mode, inference_version,
                                  inference_activated_at)
       SELECT $1, f.id, 'active', 1, $2::timestamptz - interval '40 days'
         FROM feeds f WHERE f.id % 3 = $3`,
      [filler.id, at, fillers.indexOf(filler)],
    );
  }

  const total = COST_WINDOW_ARTICLES + COST_OLD_ARTICLES;
  await owner.query(
    `INSERT INTO articles (url, canonical_url, url_key, title, title_norm, excerpt, published_at,
                           first_seen_at, content_hash, pipeline_state)
     SELECT 'https://news.example.test/cost/' || g, 'https://news.example.test/cost/' || g,
            'news.example.test/cost/' || g, 'Cost article ' || g, 'cost article ' || g,
            'Excerpt of cost article ' || g || repeat(' lorem ipsum', 20),
            CASE WHEN g % 5 = 0 THEN NULL ELSE $2::timestamptz - make_interval(secs => g * 500) END,
            CASE WHEN g <= $3::int THEN $2::timestamptz - make_interval(secs => g * 500)
                 ELSE $2::timestamptz - interval '20 days' - make_interval(secs => g * 100) END,
            encode(sha256(convert_to('cost' || g, 'UTF8')), 'hex'),
            CASE WHEN g % 40 = 0 THEN 'stale' ELSE 'enriched' END
       FROM generate_series(1, $1::int) g`,
    [total, at, COST_WINDOW_ARTICLES],
  );
  // The window spans 2,400 x 500 s = 13.9 days: newest first, as ingestion produces it.
  // One carrier per article, a second for a third, a third for a ninth; later carriers arrive
  // after the first (but never after asOf).
  await owner.query(
    `INSERT INTO feed_items (feed_id, article_id, guid, first_seen_at)
     SELECT f.id, a.id, 'g' || a.id || '-' || k.n, a.first_seen_at + make_interval(secs => (k.n - 1) * 60)
       FROM articles a
       CROSS JOIN LATERAL generate_series(1, CASE WHEN a.id % 9 = 0 THEN 3 WHEN a.id % 3 = 0 THEN 2 ELSE 1 END) k(n)
       JOIN feeds f ON f.id = 1 + ((a.id * 7 + k.n * 13) % $1::int)
     ON CONFLICT DO NOTHING`,
    [COST_FEEDS],
  );
  // Story clusters of 2-4 consecutive articles for a tenth of the window.
  await owner.query(
    `WITH grp AS (
       SELECT g AS n FROM generate_series(1, ($1::int / 10) / 3) g),
     ins AS (
       INSERT INTO story_clusters (representative_article_id, size)
       SELECT (n - 1) * 30 + 1, 3 FROM grp RETURNING id, representative_article_id)
     UPDATE articles a SET story_cluster_id = ins.id
       FROM ins WHERE a.id BETWEEN ins.representative_article_id AND ins.representative_article_id + 2`,
    [COST_WINDOW_ARTICLES],
  );
  // Stored rankings for ~75 % of the window (the rest are unranked and so "pending").
  await owner.query(
    `INSERT INTO user_article (user_id, article_id, lane, tier, p_like, score_source, score_version,
                               rank_revision, read_at, archived_at, scored_at)
     SELECT $1, a.id, x.lane, x.tier, x.p, CASE WHEN x.p IS NULL THEN 'none' ELSE 'cards' END,
            $3, 0,
            CASE WHEN a.id % 4 = 0 THEN $2::timestamptz END,
            CASE WHEN a.id % 37 = 0 THEN $2::timestamptz END, $2::timestamptz
       FROM articles a
       CROSS JOIN LATERAL (SELECT (a.id * 2654435761 % 1000) / 1000.0 AS r) q
       CROSS JOIN LATERAL (SELECT
              CASE WHEN q.r < 0.15 THEN 'for_you' WHEN q.r < 0.30 THEN 'maybe'
                   WHEN q.r < 0.65 THEN 'everything' ELSE 'new' END AS lane,
              CASE WHEN q.r < 0.65 THEN (0.05 + q.r)::real END AS p,
              CASE WHEN q.r < 0.15 THEN 5 WHEN q.r < 0.30 THEN 3 WHEN q.r < 0.65 THEN 1 END AS tier) x
      WHERE a.id <= $4::int AND a.id % 4 <> 3`,
    [user.id, at, COST_SCORE_VERSION, COST_WINDOW_ARTICLES],
  );
  for (const filler of fillers) {
    await owner.query(
      `INSERT INTO user_article (user_id, article_id, lane, tier, p_like, score_source, score_version,
                                 rank_revision, scored_at)
       SELECT $1, a.id, 'everything', 1, 0.3, 'cards', $3, 0, $2::timestamptz
         FROM articles a WHERE a.id <= $4::int AND a.id % 3 = $5::int`,
      [filler.id, at, COST_SCORE_VERSION, COST_WINDOW_ARTICLES, fillers.indexOf(filler)],
    );
  }
  // Selected analysis requests for a third of the training feeds' window articles.
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [user.id]);
    await client.query(
      `INSERT INTO analysis_requests (id, user_id, feed_id, article_id, article_revision,
                                      inference_version, input_snapshot, input_sha)
       SELECT gen_random_uuid(), $1, fi.feed_id, a.id, a.content_revision, s.inference_version,
              '{}'::jsonb, encode(sha256(convert_to('{}', 'UTF8')), 'hex')
         FROM feed_items fi
         JOIN articles a ON a.id = fi.article_id
         JOIN subscriptions s ON s.user_id = $1 AND s.feed_id = fi.feed_id
        WHERE s.inference_mode = 'training' AND a.id <= $2::int AND a.id % 3 = 0`,
      [user.id, COST_WINDOW_ARTICLES],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  for (const table of [
    'feeds',
    'subscriptions',
    'articles',
    'feed_items',
    'story_clusters',
    'user_article',
    'analysis_requests',
    'users',
  ]) {
    await owner.query(`ANALYZE ${table}`);
  }
  return { userId: user.id, asOf, feedCount: COST_FEEDS, windowArticles: COST_WINDOW_ARTICLES };
}
