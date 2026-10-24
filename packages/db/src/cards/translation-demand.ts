import {
  readerSchema,
  CardTextModeSchema,
  enqueueTranslateCards,
  type JobSender,
} from '@bantoozi/shared';
import { sql } from 'drizzle-orm';

import type { Executor } from '../client.js';
import { SELECTION_WINDOW_DAYS } from '../ingest/demand.js';
import { readStoredSetting } from '../settings.js';

/**
 * Card translation demand (spec 07 §5, spec 11 §6): which cards `house.translate-cards` may send to
 * the tier-1 translator, and the API's trigger that records the job when a user's cards gain demand.
 */

/** A card that lacks its English pair and has current authorized demand. */
export interface CardAwaitingTranslation {
  cardId: string;
  lang: string;
  interest: string;
  notFor: string | null;
  /** The non-deleted holders whose demand authorizes the translation. */
  holders: string[];
}

/**
 * Non-retired cards (interests and labels) in one of `langs` with no English pair whose holder is
 * non-deleted and either has an `active` subscription within the holding's scope or a live
 * selected request at the subscription's inference version (spec 07 §5, the demand rule of
 * `cardPairDemand` without an article). `userId` restricts to that user's held cards, `cardId` to
 * one card; `after` pages by card id ascending; `notAttemptedSince` skips cards stamped by
 * `markCardTranslationAttempt` after that time (the weak or failed backoff).
 */
export async function cardsAwaitingTranslation(
  db: Executor,
  input: {
    langs: readonly string[];
    userId?: string;
    cardId?: string;
    after?: string;
    limit?: number;
    /** Leave out cards whose translation was attempted (weak or failed) after this time. */
    notAttemptedSince?: Date;
  },
): Promise<CardAwaitingTranslation[]> {
  if (input.langs.length === 0) return [];
  const user = input.userId === undefined ? sql`` : sql`AND x.user_id = ${input.userId}::uuid`;
  const card = input.cardId === undefined ? sql`` : sql`AND c.id = ${input.cardId}::bigint`;
  const after = input.after === undefined ? sql`` : sql`AND c.id > ${input.after}::bigint`;
  const backoff =
    input.notAttemptedSince === undefined
      ? sql``
      : sql`AND (c.translation_attempted_at IS NULL
                 OR c.translation_attempted_at <= ${input.notAttemptedSince.toISOString()}::timestamptz)`;
  const limit = input.limit === undefined ? sql`` : sql`LIMIT ${input.limit}`;
  const result = await db.execute<{
    card_id: string;
    lang: string;
    interest: string;
    not_for: string | null;
    holders: string[];
  }>(sql`
    WITH holdings AS (
      SELECT user_id, card_id, scope_feed_id, 'card' AS holding FROM user_cards
      UNION ALL
      SELECT user_id, card_id, NULL::bigint, 'label' FROM user_labels
    ), demand AS (
      SELECT x.user_id, x.card_id, x.holding
        FROM holdings x
        JOIN users u ON u.id = x.user_id AND u.deleted_at IS NULL
        JOIN subscriptions s ON s.user_id = x.user_id AND s.inference_mode = 'active'
                            AND (x.scope_feed_id IS NULL OR s.feed_id = x.scope_feed_id)
      UNION
      SELECT x.user_id, x.card_id, x.holding
        FROM holdings x
        JOIN users u ON u.id = x.user_id AND u.deleted_at IS NULL
        JOIN analysis_requests r ON r.user_id = x.user_id
                                AND (x.scope_feed_id IS NULL OR r.feed_id = x.scope_feed_id)
        JOIN articles a ON a.id = r.article_id AND a.content_revision = r.article_revision
        JOIN subscriptions s ON s.user_id = r.user_id AND s.feed_id = r.feed_id
                            AND s.inference_mode IN ('training', 'active')
                            AND s.inference_version = r.inference_version
       WHERE r.status IN ('pending', 'running', 'complete')
         AND r.created_at > now() - make_interval(days => ${SELECTION_WINDOW_DAYS})
    )
    SELECT c.id::text AS card_id, c.lang, c.body->>'interest' AS interest,
           c.body->>'not_for' AS not_for,
           array_agg(DISTINCT x.user_id::text ORDER BY x.user_id::text) AS holders
      FROM interest_cards c
      JOIN demand x ON x.card_id = c.id
                   AND (c.visibility <> 'private' OR c.owner_user_id = x.user_id)
                   AND (c.kind = 'label') = (x.holding = 'label')
     WHERE c.retired_at IS NULL
       AND c.lang = ANY(${sql.param([...input.langs])}::text[])
       AND c.body->>'interest_en' IS NULL AND c.body->>'not_for_en' IS NULL
       AND c.body->>'interest' IS NOT NULL
       ${user} ${card} ${after} ${backoff}
     GROUP BY c.id
     ORDER BY c.id
     ${limit}`);
  return result.rows.map((row) => ({
    cardId: row.card_id,
    lang: row.lang,
    interest: row.interest,
    notFor: row.not_for,
    holders: row.holders,
  }));
}

/**
 * Record `house.translate-cards {userId}` in the caller's transaction while `card_text_mode =
 * 'english'` (spec 07 §5): the user's cards gained authorized demand (a feed was activated or
 * articles were selected). Nothing is recorded while card text is as written.
 */
export async function recordCardTranslationDemand(
  tx: Executor,
  sender: JobSender,
  userId: string,
): Promise<boolean> {
  const mode = readerSchema(CardTextModeSchema).safeParse(
    (await readStoredSetting(tx, 'card_text_mode')) ?? 'as_written',
  );
  if (!mode.success || mode.data !== 'english') return false;
  await enqueueTranslateCards(sender, { userId });
  return true;
}
