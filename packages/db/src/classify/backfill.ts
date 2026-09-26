import { sql } from 'drizzle-orm';

import type { Executor } from '../client.js';
import { SELECTION_WINDOW_DAYS } from '../ingest/demand.js';

/** Distinct articles per backfill page (spec 05 §5.4 step 3). */
export const BACKFILL_PAGE_SIZE = 500;
/** Queue priority of the first 50 articles of a whole backfill request, then of the rest (§5.4 step 4). */
export const BACKFILL_PRIORITY_FIRST = 2;
export const BACKFILL_PRIORITY_REST = 6;
export const BACKFILL_INTERACTIVE_ARTICLES = 50;

/** A card or label the user still holds, with its scope (spec 05 §5.4 step 1 revalidation). */
export interface HeldBackfillCard {
  cardId: string;
  kind: 'interest' | 'label';
  /** `user_cards.scope_feed_id`; labels are unscoped. */
  scopeFeedId: string | null;
}

/**
 * Which of `cardIds` an active (non-deleted) user still holds (spec 05 §5.4 step 1): a non-retired
 * card through `user_cards` or a label through `user_labels`, a private card only when the user owns
 * it. Empty for a deleted or unknown user.
 */
export async function heldBackfillCards(
  db: Executor,
  userId: string,
  cardIds: readonly string[],
): Promise<HeldBackfillCard[]> {
  if (cardIds.length === 0) return [];
  const result = await db.execute<{
    card_id: string;
    kind: 'interest' | 'label';
    scope_feed_id: string | null;
  }>(sql`
    SELECT DISTINCT c.id::text AS card_id, c.kind, x.scope_feed_id::text AS scope_feed_id
      FROM (SELECT user_id, card_id, scope_feed_id, 'interest' AS holding FROM user_cards
            UNION ALL
            SELECT user_id, card_id, NULL::bigint, 'label' FROM user_labels) x
      JOIN users u ON u.id = x.user_id AND u.deleted_at IS NULL
      JOIN interest_cards c ON c.id = x.card_id AND c.retired_at IS NULL AND c.kind = x.holding
                           AND (c.visibility <> 'private' OR c.owner_user_id = x.user_id)
     WHERE x.user_id = ${userId}::uuid
       AND x.card_id = ANY(${sql.param([...cardIds])}::bigint[])
     ORDER BY 1`);
  return result.rows.map((row) => ({
    cardId: row.card_id,
    kind: row.kind,
    scopeFeedId: row.scope_feed_id,
  }));
}

/** A page cursor: the last visited `(firstSeenAt, articleId)` key, exclusive. */
export interface BackfillCursor {
  /** ISO timestamp with microseconds (the exact database value). */
  firstSeenAt: string;
  articleId: string;
}

/** One article of a backfill page. */
export interface BackfillArticle {
  articleId: string;
  /** Page key: the latest eligible carrier arrival, ISO with microseconds. */
  pageKey: string;
  /** Carriers through which this user's demand admits the article (for card scopes). */
  feedIds: string[];
}

/**
 * One page of a backfill (spec 05 §5.4 steps 1–3): the user's articles with admitted demand whose
 * eligible carrier arrival lies in `[snapshotAt − windowDays, snapshotAt]`, where admission is an
 * `active` subscription to that carrier with the arrival at/after activation (a non-stale article),
 * or a current selected request of this user for that article and feed (spec 05 §1.1). Off and
 * unselected training carriers contribute nothing: a backfill never expands authorization.
 * `feedIds` restricts the carriers. Articles are keyed by their latest eligible carrier arrival
 * (not the global article time), ordered `(key, id)` descending and read strictly below `cursor`.
 */
export async function backfillPage(
  db: Executor,
  input: {
    userId: string;
    feedIds?: readonly string[];
    snapshotAt: Date;
    windowDays: number;
    cursor?: BackfillCursor;
    limit?: number;
  },
): Promise<BackfillArticle[]> {
  const feedFilter =
    input.feedIds === undefined
      ? sql``
      : sql`AND fi.feed_id = ANY(${sql.param([...input.feedIds])}::bigint[])`;
  const snapshot = input.snapshotAt.toISOString();
  const cursorFilter =
    input.cursor === undefined
      ? sql``
      : sql`HAVING (max(e.first_seen_at), e.article_id)
                   < (${input.cursor.firstSeenAt}::timestamptz, ${input.cursor.articleId}::bigint)`;
  const result = await db.execute<{
    article_id: string;
    page_key: string;
    feed_ids: string[];
  }>(sql`
    WITH eligible AS (
      SELECT fi.article_id, fi.feed_id, fi.first_seen_at
        FROM subscriptions s
        JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL
        JOIN feed_items fi ON fi.feed_id = s.feed_id AND fi.first_seen_at >= s.inference_activated_at
        JOIN articles a ON a.id = fi.article_id AND a.pipeline_state <> 'stale'
       WHERE s.user_id = ${input.userId}::uuid AND s.inference_mode = 'active' ${feedFilter}
      UNION
      SELECT fi.article_id, fi.feed_id, fi.first_seen_at
        FROM analysis_requests r
        JOIN users u ON u.id = r.user_id AND u.deleted_at IS NULL
        JOIN articles a ON a.id = r.article_id AND a.content_revision = r.article_revision
        JOIN feed_items fi ON fi.article_id = r.article_id AND fi.feed_id = r.feed_id
        JOIN subscriptions s ON s.user_id = r.user_id AND s.feed_id = r.feed_id
                            AND s.inference_mode IN ('training', 'active')
                            AND s.inference_version = r.inference_version
       WHERE r.user_id = ${input.userId}::uuid
         AND r.status IN ('pending', 'running', 'complete')
         AND r.created_at > now() - make_interval(days => ${SELECTION_WINDOW_DAYS})
         ${feedFilter}
    )
    SELECT e.article_id::text AS article_id,
           to_char(max(e.first_seen_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS page_key,
           array_agg(DISTINCT e.feed_id::text) AS feed_ids
      FROM eligible e
     WHERE e.first_seen_at <= ${snapshot}::timestamptz
       AND e.first_seen_at >= ${snapshot}::timestamptz - make_interval(days => ${input.windowDays})
     GROUP BY e.article_id
     ${cursorFilter}
     ORDER BY max(e.first_seen_at) DESC, e.article_id DESC
     LIMIT ${input.limit ?? BACKFILL_PAGE_SIZE}`);
  return result.rows.map((row) => ({
    articleId: row.article_id,
    pageKey: row.page_key,
    feedIds: [...row.feed_ids].sort(),
  }));
}

/** The user's plan backfill window in days (spec 05 §5.4 step 2, `plans.backfill_days`). */
export async function userPlan(
  db: Executor,
  userId: string,
): Promise<{ plan: string; deleted: boolean } | null> {
  const result = await db.execute<{ plan: string; deleted: boolean }>(sql`
    SELECT plan, deleted_at IS NOT NULL AS deleted FROM users WHERE id = ${userId}::uuid`);
  return result.rows[0] ?? null;
}
