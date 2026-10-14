import { sql } from 'drizzle-orm';

import { tenantUserId, type TenantTx } from '../tenant.js';

/** How many recently liked articles a held card matched (see {@link listCardUsage}). */
export interface CardUsage {
  cardId: string;
  likedMatches: number;
}

/** The look-back window of {@link listCardUsage}. */
const USAGE_DAYS = 90;

/**
 * One entry per card the tenant holds: the distinct articles rated +1 in the last 90 days that the
 * card answered at the article's current revision, by a model (not the prefilter), with a
 * probability of at least `maybeThreshold`. Another user's ratings are never counted (RLS).
 */
export async function listCardUsage(tx: TenantTx, maybeThreshold: number): Promise<CardUsage[]> {
  const userId = tenantUserId(tx);
  const result = await tx.execute<{ card_id: string; liked_matches: number }>(sql`
    SELECT uc.card_id::text AS card_id,
           (SELECT count(DISTINCT ua.article_id)::int
              FROM user_article ua
              JOIN articles a ON a.id = ua.article_id
              JOIN card_answers ca ON ca.article_id = ua.article_id
                                  AND ca.card_id = uc.card_id
                                  AND ca.article_revision = a.content_revision
             WHERE ua.user_id = ${userId}::uuid
               AND ua.rating = 1
               AND ua.rated_at >= now() - make_interval(days => ${USAGE_DAYS})
               AND ca.engine <> 'prefilter'
               AND ca.p >= ${maybeThreshold}) AS liked_matches
      FROM user_cards uc
     WHERE uc.user_id = ${userId}::uuid
     ORDER BY uc.card_id`);
  return result.rows.map((row) => ({ cardId: row.card_id, likedMatches: row.liked_matches }));
}
