import { sql } from 'drizzle-orm';

import type { Executor } from '../client.js';
import { activeSubscriberIds, automaticCardDemand } from './demand.js';

/**
 * The demand a newly inserted `feed_items` association creates (spec 03 §7 "A feed newly carrying
 * an already-processed article", spec 05 §5.3): the facts `pipeline.afterNewCarrier` routes on.
 */
export interface NewCarrierDemand {
  articleId: string;
  feedId: string;
  /** `articles.content_revision`. */
  revision: string;
  /** `articles.pipeline_state`. */
  pipelineState: string;
  /**
   * An active account holds an `active` subscription to this feed whose `inference_activated_at`
   * is at/before this association's `feed_items.first_seen_at`, and the article is not stale.
   */
  createsDemand: boolean;
  /**
   * Cards and labels admitted through **this** carrier (`automaticCardDemand(…, {feedId})`) that
   * lack a current primary answer: no `card_answers` row at `revision` from a primary engine
   * (`typesafe`, `laya`). LLM and prefilter answers are provisional and do not count (spec 05
   * §5.5). The match handler still checks every cache fingerprint before reusing an answer.
   */
  missingCardIds: string[];
  /** Active-account subscribers of this feed, in UUID order: each gets an incremental rank. */
  subscriberIds: string[];
}

/** Engines whose card answers satisfy a pair (spec 05 §5.5: approved primary engines only). */
const PRIMARY_ANSWER_ENGINES = ['typesafe', 'laya'] as const;

/**
 * Resolve the eligible demand of the newly inserted association (`feedId`, `articleId`) in the
 * caller's transaction (spec 03 §7, spec 05 §1.1, §5.3): activation time, generation and scope are
 * checked for this carrier only, so `feed_cards` alone never authorizes a historical arrival, an
 * off or training subscriber, or a deleted account, and other carriers' demand is not re-queued.
 * The article row is share-locked until commit, so the revision the caller queues match work at
 * cannot be replaced by a concurrent reset in between. `null` when the association or the article
 * no longer exists.
 */
export async function newCarrierDemand(
  db: Executor,
  articleId: string,
  feedId: string,
): Promise<NewCarrierDemand | null> {
  // The activation boundary is compared in SQL: a JavaScript Date would drop the microseconds.
  const head = await db.execute<{
    revision: string;
    pipeline_state: string;
    activated: boolean;
  }>(sql`
    SELECT a.content_revision::text AS revision, a.pipeline_state,
           EXISTS (SELECT 1
                     FROM subscriptions s
                     JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL
                    WHERE s.feed_id = fi.feed_id AND s.inference_mode = 'active'
                      AND s.inference_activated_at <= fi.first_seen_at) AS activated
      FROM feed_items fi
      JOIN articles a ON a.id = fi.article_id
     WHERE fi.feed_id = ${feedId}::bigint AND fi.article_id = ${articleId}::bigint
       FOR SHARE OF a`);
  const row = head.rows[0];
  if (row === undefined) return null;
  const createsDemand = row.pipeline_state !== 'stale' && row.activated;

  const admitted = await automaticCardDemand(db, articleId, { feedId });
  let missingCardIds = admitted;
  if (admitted.length > 0) {
    const answered = await db.execute<{ card_id: string }>(sql`
      SELECT card_id::text AS card_id FROM card_answers
       WHERE article_id = ${articleId}::bigint AND article_revision = ${row.revision}::bigint
         AND engine = ANY(${sql.param([...PRIMARY_ANSWER_ENGINES])}::text[])
         AND card_id = ANY(${sql.param(admitted)}::bigint[])`);
    const answeredIds = new Set(answered.rows.map((r) => r.card_id));
    missingCardIds = admitted.filter((id) => !answeredIds.has(id));
  }

  return {
    articleId,
    feedId,
    revision: row.revision,
    pipelineState: row.pipeline_state,
    createsDemand,
    missingCardIds,
    subscriberIds: await activeSubscriberIds(db, [feedId]),
  };
}
