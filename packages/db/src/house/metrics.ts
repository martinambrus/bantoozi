import { sql } from 'drizzle-orm';

import type { Executor } from '../client.js';

/** One explicit-rating event (`rate`, `unrate` or the undo of a rating) of the metrics window. */
export interface MetricsRatingEvent {
  userId: string;
  articleId: string;
  kind: 'rate' | 'unrate' | 'undo';
  rating: number | null;
  /** The `before.lane` of the feedback snapshot (spec 06 §8.2), `null` when it holds none. */
  lane: string | null;
  at: Date;
}

/**
 * The rating events with `from <= created_at < to`, grouped by user and article and in event order,
 * for the effective-rating replay of `house.metrics` (spec 10 §7). Callers must not retain the ids.
 */
export async function metricsRatingEvents(
  db: Executor,
  from: Date,
  to: Date,
): Promise<MetricsRatingEvent[]> {
  const result = await db.execute<{
    user_id: string;
    article_id: string;
    kind: 'rate' | 'unrate' | 'undo';
    rating: string | null;
    lane: string | null;
    at: number;
  }>(sql`
    SELECT user_id::text AS user_id, article_id::text AS article_id, kind,
           value->>'rating' AS rating, value->'before'->>'lane' AS lane,
           (extract(epoch FROM created_at) * 1000)::float8 AS at
      FROM feedback_events
     WHERE created_at >= ${from.toISOString()}::timestamptz
       AND created_at < ${to.toISOString()}::timestamptz
       AND (kind IN ('rate', 'unrate') OR (kind = 'undo' AND value->>'action' = 'rating'))
     ORDER BY user_id, article_id, id`);
  return result.rows.map((row) => ({
    userId: row.user_id,
    articleId: row.article_id,
    kind: row.kind,
    rating: row.rating === null ? null : Number(row.rating),
    lane: row.lane,
    at: new Date(row.at),
  }));
}

/**
 * Observed recovery from Everything/Hidden over `from <= created_at < to` (spec 10 §7): distinct
 * user/article pairs opened, bookmarked or liked from a downranked pre-action lane, against the
 * eligible pairs, those with feedback from a downranked lane in the window and those downranked now.
 */
export async function metricsRecovery(
  db: Executor,
  from: Date,
  to: Date,
): Promise<{ numerator: number; denominator: number }> {
  const start = from.toISOString();
  const end = to.toISOString();
  const result = await db.execute<{ numerator: number; denominator: number }>(sql`
    WITH downranked AS (
      SELECT user_id, article_id,
             (kind IN ('open', 'bookmark') OR (kind = 'rate' AND value->>'rating' = '1')) AS recovered
        FROM feedback_events
       WHERE created_at >= ${start}::timestamptz AND created_at < ${end}::timestamptz
         AND value->'before'->>'lane' IN ('everything', 'hidden')
    ), eligible AS (
      SELECT user_id, article_id FROM downranked
      UNION
      SELECT user_id, article_id FROM user_article WHERE lane IN ('everything', 'hidden')
    )
    SELECT (SELECT count(*) FROM (SELECT DISTINCT user_id, article_id FROM downranked WHERE recovered) r)::int
             AS numerator,
           (SELECT count(*) FROM eligible)::int AS denominator`);
  return {
    numerator: result.rows[0]?.numerator ?? 0,
    denominator: result.rows[0]?.denominator ?? 0,
  };
}

/** Deletes the `metrics.daily.<date>` rows of days before `oldestKept` (`YYYY-MM-DD`); returns the count. */
export async function deleteMetricsSnapshotsBefore(
  db: Executor,
  oldestKept: string,
): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM settings
     WHERE key ~ '^metrics\\.daily\\.[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       AND key < ${`metrics.daily.${oldestKept}`}`);
  return result.rowCount ?? 0;
}
