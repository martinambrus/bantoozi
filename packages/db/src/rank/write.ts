import { sql } from 'drizzle-orm';

import type { Transaction } from '../client.js';

/** The ranking columns of one row to write (spec 06 §7 step 5). */
export interface RankWrite {
  articleId: string;
  /** The article revisions the result was computed from; a moved article discards the row. */
  contentRevision: string;
  mediaRevision: string;
  lane: string;
  tier: number | null;
  pLike: number | null;
  scoreSource: string;
  rulesFired: readonly string[];
  explain: unknown;
  labelSuggestions: readonly string[];
  nextRankAt: Date | null;
}

/** What fences a rank run's writes (spec 06 §7 step 5). */
export interface RankWriteFence {
  userId: string;
  /** `users.rank_revision` the run captured. */
  rankRevision: string;
  /** `ranker.settings_version` the run captured, as a decimal string. */
  settingsVersion: string;
  scoreVersion: string;
  /** The run's snapshot time, stored as `scored_at`; a newer stored snapshot is never overwritten. */
  scoredAt: Date;
}

export type RankWriteResult =
  | { status: 'written'; written: string[]; movedArticleIds: string[] }
  /** The user's rank revision or the ranking settings changed: nothing was written. */
  | { status: 'superseded' }
  /** The account is gone (deleted or being deleted): nothing was written. */
  | { status: 'gone' };

/**
 * Upserts one batch of results (spec 06 §7 step 5). Inside the caller's transaction it
 * 1. takes the user's rank lock (`pg_advisory_xact_lock`), so concurrent runs of one user write in
 *    turn, and share-locks the user row and both ranking settings rows, comparing the captured rank
 *    revision and settings version with the current ones: if either changed, it writes nothing;
 * 2. writes only rows whose article still has the captured content and media revisions (the rest
 *    are reported as moved), and never replaces a row scored from a newer snapshot;
 * 3. sets only the ranking columns: reader state (read, rating, bookmark, labels, archive) is never
 *    touched, and label suggestions are filtered against the labels the user holds and the row's
 *    current assignments at write time, so a concurrent label action is not undone.
 * Rows are written in article id order. Returns the article ids written.
 */
export async function writeRankBatch(
  tx: Transaction,
  fence: RankWriteFence,
  rows: readonly RankWrite[],
): Promise<RankWriteResult> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`rank:${fence.userId}`}, 0))`,
  );
  const user = await tx.execute<{ rank_revision: string }>(sql`
    SELECT rank_revision::text AS rank_revision FROM users
     WHERE id = ${fence.userId}::uuid AND deleted_at IS NULL FOR SHARE`);
  const current = user.rows[0];
  if (current === undefined) return { status: 'gone' };
  if (current.rank_revision !== fence.rankRevision) return { status: 'superseded' };
  const settings = await tx.execute<{ value: unknown }>(sql`
    SELECT value FROM settings WHERE key = 'ranker.settings_version' FOR SHARE`);
  await tx.execute(sql`SELECT 1 FROM settings WHERE key = 'ranker.thresholds' FOR SHARE`);
  const version = settings.rows[0]?.value;
  const settingsVersion = version === undefined ? '0' : JSON.stringify(version);
  if (settingsVersion !== fence.settingsVersion) return { status: 'superseded' };
  if (rows.length === 0) return { status: 'written', written: [], movedArticleIds: [] };

  const sorted = [...rows].sort((a, b) =>
    BigInt(a.articleId) < BigInt(b.articleId)
      ? -1
      : BigInt(a.articleId) > BigInt(b.articleId)
        ? 1
        : 0,
  );
  const payload = JSON.stringify(
    sorted.map((row) => ({
      article_id: row.articleId,
      content_revision: row.contentRevision,
      media_revision: row.mediaRevision,
      lane: row.lane,
      tier: row.tier,
      p_like: row.pLike,
      score_source: row.scoreSource,
      rules_fired: row.rulesFired,
      explain: row.explain,
      label_suggestions: row.labelSuggestions,
      next_rank_at: row.nextRankAt?.toISOString() ?? null,
    })),
  );
  const scoredAt = fence.scoredAt.toISOString();
  const result = await tx.execute<{ article_id: string }>(sql`
    WITH input AS (
      SELECT r.* FROM jsonb_to_recordset(${payload}::jsonb) AS r(
               article_id bigint, content_revision bigint, media_revision bigint, lane text,
               tier smallint, p_like real, score_source text, rules_fired text[], explain jsonb,
               label_suggestions bigint[], next_rank_at timestamptz)
       JOIN articles a ON a.id = r.article_id AND a.content_revision = r.content_revision
                      AND a.media_revision = r.media_revision
    )
    INSERT INTO user_article AS ua
           (user_id, article_id, lane, tier, p_like, score_source, rules_fired, explain,
            label_suggestions, score_version, rank_revision, scored_at, next_rank_at)
    SELECT ${fence.userId}::uuid, i.article_id, i.lane, i.tier, i.p_like, i.score_source,
           i.rules_fired, i.explain,
           ARRAY(SELECT s FROM unnest(i.label_suggestions) AS s
                  WHERE EXISTS (SELECT 1 FROM user_labels l
                                 WHERE l.user_id = ${fence.userId}::uuid AND l.card_id = s)),
           ${fence.scoreVersion}, ${fence.rankRevision}::bigint, ${scoredAt}::timestamptz,
           i.next_rank_at
      FROM input i
     ORDER BY i.article_id
    ON CONFLICT (user_id, article_id) DO UPDATE SET
      lane = EXCLUDED.lane, tier = EXCLUDED.tier, p_like = EXCLUDED.p_like,
      score_source = EXCLUDED.score_source, rules_fired = EXCLUDED.rules_fired,
      explain = EXCLUDED.explain,
      label_suggestions = ARRAY(SELECT s FROM unnest(EXCLUDED.label_suggestions) AS s
                                 WHERE s <> ALL (ua.label_ids)),
      score_version = EXCLUDED.score_version, rank_revision = EXCLUDED.rank_revision,
      scored_at = EXCLUDED.scored_at, next_rank_at = EXCLUDED.next_rank_at
    WHERE ua.scored_at IS NULL OR ua.scored_at <= EXCLUDED.scored_at
    RETURNING ua.article_id::text AS article_id`);
  const written = result.rows.map((row) => row.article_id);
  const moved = await tx.execute<{ article_id: string }>(sql`
    SELECT r.article_id::text AS article_id
      FROM jsonb_to_recordset(${payload}::jsonb) AS r(
             article_id bigint, content_revision bigint, media_revision bigint)
      LEFT JOIN articles a ON a.id = r.article_id
     WHERE a.id IS NULL OR a.content_revision <> r.content_revision
        OR a.media_revision <> r.media_revision`);
  return {
    status: 'written',
    written,
    movedArticleIds: moved.rows.map((row) => row.article_id),
  };
}
