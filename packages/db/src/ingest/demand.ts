import type { InferenceAuthorization } from '@bantoozi/shared';
import { sql } from 'drizzle-orm';

import type { Executor } from '../client.js';

/**
 * Inference demand (spec 03 §1.1, spec 05 §1.1, spec 02 §3.4). Ingestion runs for every subscribed
 * feed; model inference needs a live per-user authorization. These queries are the single
 * `eligibleInferenceDemand(articleId, tx)` contract that `pipeline.after`, the new-carrier fan-out,
 * resets and later provider boundaries all use. `feed_cards` is only a candidate cache: every answer
 * here is recomputed from live users, subscriptions, activation times and scopes.
 */

/** One live authorization for model inference on an article (the `witnesses` of the engine port). */
export type InferenceWitness = Extract<
  InferenceAuthorization,
  { type: 'article' }
>['witnesses'][number];

/**
 * A selected request authorizes inference only inside its 180-day retention window, whether or not
 * housekeeping has cancelled it yet (spec 05 §1.1, spec 11 §5).
 */
export const SELECTION_WINDOW_DAYS = 180;

/**
 * Every live authorization for the article's **current** revision:
 * - automatic: an active account's `active` subscription to a carrier whose
 *   `feed_items.first_seen_at` is at/after `inference_activated_at`, for a non-stale article
 *   (activation is prospective and stale articles are outside the automatic age window);
 * - manual: a pending, running or complete selected `analysis_requests` row of an active account
 *   whose subscription is still `training`/`active` at the request's inference version, created
 *   within the selection window, and frozen at the article's current revision (new content needs a
 *   new selection; a stale article can still be selected).
 * Off subscriptions and unselected training articles yield nothing.
 */
export async function eligibleInferenceDemand(
  db: Executor,
  articleId: string,
): Promise<InferenceWitness[]> {
  const result = await db.execute<{
    kind: 'automatic' | 'manual';
    user_id: string;
    feed_id: string;
    inference_version: string | null;
    request_id: string | null;
  }>(sql`
    SELECT 'automatic' AS kind, s.user_id::text AS user_id, s.feed_id::text AS feed_id,
           s.inference_version::text AS inference_version, NULL::text AS request_id
      FROM feed_items fi
      JOIN articles a ON a.id = fi.article_id AND a.pipeline_state <> 'stale'
      JOIN subscriptions s ON s.feed_id = fi.feed_id AND s.inference_mode = 'active'
                          AND fi.first_seen_at >= s.inference_activated_at
      JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL
     WHERE fi.article_id = ${articleId}::bigint
    UNION
    SELECT 'manual', r.user_id::text, r.feed_id::text, NULL::text, r.id::text
      FROM analysis_requests r
      JOIN articles a ON a.id = r.article_id AND a.content_revision = r.article_revision
      JOIN subscriptions s ON s.user_id = r.user_id AND s.feed_id = r.feed_id
                          AND s.inference_mode IN ('training', 'active')
                          AND s.inference_version = r.inference_version
      JOIN users u ON u.id = r.user_id AND u.deleted_at IS NULL
     WHERE r.article_id = ${articleId}::bigint
       AND r.status IN ('pending', 'running', 'complete')
       AND r.created_at > now() - make_interval(days => ${SELECTION_WINDOW_DAYS})
     ORDER BY 1, 2, 3, 5`);
  return result.rows.map((row) =>
    row.kind === 'automatic'
      ? {
          kind: 'automatic',
          userId: row.user_id,
          feedId: row.feed_id,
          inferenceVersion: row.inference_version ?? '0',
        }
      : { kind: 'manual', analysisRequestId: row.request_id ?? '' },
  );
}

/** Whether any live authorization exists (the demand gate after extraction, spec 03 §1). */
export async function hasInferenceDemand(db: Executor, articleId: string): Promise<boolean> {
  return (await eligibleInferenceDemand(db, articleId)).length > 0;
}

/**
 * The automatic **article/card** union (spec 05 §1.1, §5.3): cards and labels held by active
 * accounts through an `active` subscription to a carrier that arrived at/after activation, whose
 * scope includes that carrier, not retired, for a non-stale article. With `feedId`, only that carrier
 * is considered (the demand a newly inserted `feed_items` association creates, spec 03 §7).
 * Selected-request cards come from their frozen manifests (`analysis.process`), not from here.
 */
export async function automaticCardDemand(
  db: Executor,
  articleId: string,
  options: { feedId?: string } = {},
): Promise<string[]> {
  const feedId = options.feedId ?? null;
  const result = await db.execute<{ card_id: string }>(sql`
    SELECT DISTINCT x.card_id::text AS card_id
      FROM feed_items fi
      JOIN articles a ON a.id = fi.article_id AND a.pipeline_state <> 'stale'
      JOIN subscriptions s ON s.feed_id = fi.feed_id AND s.inference_mode = 'active'
                          AND fi.first_seen_at >= s.inference_activated_at
      JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL
      JOIN (SELECT user_id, card_id, scope_feed_id FROM user_cards
            UNION ALL
            SELECT user_id, card_id, NULL::bigint FROM user_labels) x
        ON x.user_id = s.user_id AND (x.scope_feed_id IS NULL OR x.scope_feed_id = fi.feed_id)
      JOIN interest_cards c ON c.id = x.card_id AND c.retired_at IS NULL
     WHERE fi.article_id = ${articleId}::bigint
       AND (${feedId}::bigint IS NULL OR fi.feed_id = ${feedId}::bigint)
     ORDER BY 1`);
  return result.rows.map((row) => row.card_id);
}

/** Active accounts subscribed to any of `feedIds`, in UUID order. */
export async function activeSubscriberIds(
  db: Executor,
  feedIds: readonly string[],
): Promise<string[]> {
  if (feedIds.length === 0) return [];
  const result = await db.execute<{ user_id: string }>(sql`
    SELECT DISTINCT s.user_id::text AS user_id
      FROM subscriptions s
      JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL
     WHERE s.feed_id = ANY(${sql.param([...feedIds])}::bigint[])
     ORDER BY 1`);
  return result.rows.map((row) => row.user_id);
}

/** Active accounts subscribed to any current carrier of the article, in UUID order. */
export async function carrierSubscriberIds(db: Executor, articleId: string): Promise<string[]> {
  const result = await db.execute<{ user_id: string }>(sql`
    SELECT DISTINCT s.user_id::text AS user_id
      FROM feed_items fi
      JOIN subscriptions s ON s.feed_id = fi.feed_id
      JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL
     WHERE fi.article_id = ${articleId}::bigint
     ORDER BY 1`);
  return result.rows.map((row) => row.user_id);
}

/**
 * Active accounts subscribed to a carrier of any member of the article's story cluster (or of the
 * article itself when it is unclustered), in UUID order: the users a cluster-membership change may
 * re-rank (spec 06 §7, spec 03 §1). A superset is harmless: ranking recomputes from current state.
 */
export async function storySubscriberIds(db: Executor, articleId: string): Promise<string[]> {
  const result = await db.execute<{ user_id: string }>(sql`
    SELECT DISTINCT s.user_id::text AS user_id
      FROM articles a
      JOIN articles m ON m.id = a.id
                      OR (a.story_cluster_id IS NOT NULL AND m.story_cluster_id = a.story_cluster_id)
      JOIN feed_items fi ON fi.article_id = m.id
      JOIN subscriptions s ON s.feed_id = fi.feed_id
      JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL
     WHERE a.id = ${articleId}::bigint
     ORDER BY 1`);
  return result.rows.map((row) => row.user_id);
}

/** The article's detected language (`articles.lang`), or null when unknown or the article is gone. */
export async function articleLanguage(db: Executor, articleId: string): Promise<string | null> {
  const result = await db.execute<{ lang: string | null }>(
    sql`SELECT lang FROM articles WHERE id = ${articleId}::bigint`,
  );
  return result.rows[0]?.lang ?? null;
}
