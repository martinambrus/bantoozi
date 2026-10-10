import { sql } from 'drizzle-orm';

import type { Executor } from '../client.js';
import { SELECTION_WINDOW_DAYS } from '../ingest/demand.js';

/**
 * The reads of a suggestion run (spec 05 §7 steps 1–3). Worker-role reads of one user; the
 * handler combines them with the rank evidence helpers and the pure planner of `@bantoozi/questions`.
 */

/** Likes count only this long after the rating or bookmark (spec 05 §7 step 1). */
export const SUGGEST_LIKE_WINDOW_DAYS = 30;
/** A dismissed card is not offered again for this long (spec 05 §7 step 3). */
export const SUGGEST_DISMISS_DAYS = 90;
/** At most this many most recent likes are loaded. */
export const SUGGEST_MAX_LIKES_LOADED = 200;

const DAY_MS = 86_400_000;

/**
 * Whether the user has any live inference demand: an active subscription, or a selected request
 * inside its retention window at its subscription's inference version. An off-only user has none.
 */
export async function hasSuggestDemand(db: Executor, userId: string, now: Date): Promise<boolean> {
  const cutoff = new Date(now.getTime() - SELECTION_WINDOW_DAYS * DAY_MS).toISOString();
  const result = await db.execute<{ demand: boolean }>(sql`
    SELECT (EXISTS (SELECT 1 FROM subscriptions s
                     WHERE s.user_id = ${userId}::uuid AND s.inference_mode = 'active')
            OR EXISTS (SELECT 1
                         FROM analysis_requests r
                         JOIN subscriptions s ON s.user_id = r.user_id AND s.feed_id = r.feed_id
                                             AND s.inference_mode IN ('training', 'active')
                                             AND s.inference_version = r.inference_version
                        WHERE r.user_id = ${userId}::uuid
                          AND r.status IN ('pending', 'running', 'complete')
                          AND r.created_at > ${cutoff}::timestamptz)) AS demand`);
  return result.rows[0]?.demand === true;
}

export interface SuggestLikeRow {
  articleId: string;
  /** The latest in-window rating (+1) or bookmark stamp. */
  likedAt: Date;
}

/** The user's likes of the last 30 days (rated +1 or bookmarked), most recent first. */
export async function loadSuggestLikes(
  db: Executor,
  userId: string,
  now: Date,
): Promise<SuggestLikeRow[]> {
  const cutoff = new Date(now.getTime() - SUGGEST_LIKE_WINDOW_DAYS * DAY_MS).toISOString();
  const result = await db.execute<{ article_id: string; liked_at: Date | string }>(sql`
    SELECT article_id::text AS article_id,
           greatest(CASE WHEN rating = 1 AND rated_at > ${cutoff}::timestamptz THEN rated_at END,
                    CASE WHEN bookmarked_at > ${cutoff}::timestamptz THEN bookmarked_at END) AS liked_at
      FROM user_article
     WHERE user_id = ${userId}::uuid
       AND ((rating = 1 AND rated_at > ${cutoff}::timestamptz)
            OR bookmarked_at > ${cutoff}::timestamptz)
     ORDER BY liked_at DESC, article_id DESC
     LIMIT ${SUGGEST_MAX_LIKES_LOADED}`);
  return result.rows.map((row) => ({
    articleId: row.article_id,
    likedAt: new Date(row.liked_at),
  }));
}

/** A stored card answer with the model that gave it (the primary check needs it). */
export interface SuggestAnswerRow {
  articleId: string;
  cardId: string;
  p: number;
  engine: string;
  model: string | null;
  questionSetSha: string;
  articleRevision: string;
  stateSha256: string;
  cardInputSha256: string;
}

export async function loadSuggestAnswers(
  db: Executor,
  input: { articleIds: readonly string[]; cardIds: readonly string[] },
): Promise<SuggestAnswerRow[]> {
  if (input.articleIds.length === 0 || input.cardIds.length === 0) return [];
  const result = await db.execute<{
    article_id: string;
    card_id: string;
    p: number;
    engine: string;
    model: string | null;
    question_set_sha: string;
    article_revision: string;
    state_sha256: string;
    card_input_sha256: string;
  }>(sql`
    SELECT article_id::text AS article_id, card_id::text AS card_id, p, engine, model,
           question_set_sha, article_revision::text AS article_revision, state_sha256,
           card_input_sha256
      FROM card_answers
     WHERE article_id = ANY(${sql.param([...input.articleIds])}::bigint[])
       AND card_id = ANY(${sql.param([...input.cardIds])}::bigint[])`);
  return result.rows.map((row) => ({
    articleId: row.article_id,
    cardId: row.card_id,
    p: row.p,
    engine: row.engine,
    model: row.model,
    questionSetSha: row.question_set_sha,
    articleRevision: row.article_revision,
    stateSha256: row.state_sha256,
    cardInputSha256: row.card_input_sha256,
  }));
}

export interface SuggestLibraryRow {
  id: string;
  interest: string;
  notFor: string | null;
  topicIds: string[];
}

/**
 * The offerable library (interest cards that are public, not retired and the newest library
 * version, as the API listing reads it) and the card ids to leave out: those the user holds
 * (directly, through a private fork of the card, or as a label) or dismissed in the last 90 days.
 */
export async function loadSuggestLibrary(
  db: Executor,
  userId: string,
  now: Date,
): Promise<{ cards: SuggestLibraryRow[]; excludedCardIds: string[] }> {
  const dismissedCutoff = new Date(now.getTime() - SUGGEST_DISMISS_DAYS * DAY_MS).toISOString();
  const cards = await db.execute<{
    id: string;
    interest: string | null;
    not_for: string | null;
    topic_ids: string[];
  }>(sql`
    SELECT c.id::text AS id, c.body->>'interest' AS interest, c.body->>'not_for' AS not_for,
           c.topic_ids
      FROM interest_cards c
     WHERE c.kind = 'interest' AND c.visibility = 'public' AND c.retired_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM library_card_versions o
                         JOIN library_card_versions n
                           ON n.library_slug = o.library_slug AND n.version > o.version
                        WHERE o.card_id = c.id)
     ORDER BY c.id`);
  const excluded = await db.execute<{ card_id: string }>(sql`
    SELECT uc.card_id::text AS card_id FROM user_cards uc WHERE uc.user_id = ${userId}::uuid
    UNION
    SELECT h.parent_card_id::text FROM user_cards uc
      JOIN interest_cards h ON h.id = uc.card_id
     WHERE uc.user_id = ${userId}::uuid AND h.parent_card_id IS NOT NULL
    UNION
    SELECT ul.card_id::text FROM user_labels ul WHERE ul.user_id = ${userId}::uuid
    UNION
    SELECT s.card_id::text FROM card_suggestions s
     WHERE s.user_id = ${userId}::uuid AND s.dismissed_at > ${dismissedCutoff}::timestamptz`);
  return {
    cards: cards.rows.flatMap((row) =>
      row.interest === null
        ? []
        : [{ id: row.id, interest: row.interest, notFor: row.not_for, topicIds: row.topic_ids }],
    ),
    excludedCardIds: excluded.rows.map((row) => row.card_id),
  };
}
