import { sql } from 'drizzle-orm';

import type { Executor } from '../client.js';
import { toDate, toDateOrNull, type RawTimestamp } from '../timestamps.js';

/**
 * What the rank handler loads once per run about the user (spec 06 §7 step 1). Worker-role reads:
 * the handler ranks one user at a time and never mixes another tenant's private cards or state.
 */

/** The user row a run captures: its rank revision fences every write (spec 06 §7 step 5). */
export interface RankUser {
  userId: string;
  /** `users.rank_revision` as a decimal string. */
  rankRevision: string;
  preferences: unknown;
}

/** The active (non-deleted) user, or null when the account is gone or being deleted. */
export async function loadRankUser(db: Executor, userId: string): Promise<RankUser | null> {
  const result = await db.execute<{ id: string; rank_revision: string; preferences: unknown }>(sql`
    SELECT id::text AS id, rank_revision::text AS rank_revision, preferences
      FROM users WHERE id = ${userId}::uuid AND deleted_at IS NULL`);
  const row = result.rows[0];
  return row === undefined
    ? null
    : { userId: row.id, rankRevision: row.rank_revision, preferences: row.preferences };
}

/** One held interest card as the ranker reads it (spec 06 §1 `cards`). */
export interface RankCardRow {
  cardId: string;
  /** The holder's title override, else the card title (a display-only rename, spec 05 §5.1). */
  title: string;
  strength: 'must' | 'love' | 'like' | 'never';
  scopeFeedId: string | null;
  interest: string;
  interestEn: string | null;
  lang: string;
}

/**
 * The user's held interest cards: non-retired, a private card only when the user owns it (the same
 * holding rule as demand, spec 05 §1.1), in numeric id order.
 */
export async function loadRankCards(db: Executor, userId: string): Promise<RankCardRow[]> {
  const result = await db.execute<{
    card_id: string;
    title: string;
    strength: RankCardRow['strength'];
    scope_feed_id: string | null;
    interest: string | null;
    interest_en: string | null;
    lang: string;
  }>(sql`
    SELECT c.id::text AS card_id, coalesce(uc.title_override, c.title) AS title, uc.strength,
           uc.scope_feed_id::text AS scope_feed_id, c.body->>'interest' AS interest,
           c.body->>'interest_en' AS interest_en, c.lang
      FROM user_cards uc
      JOIN interest_cards c ON c.id = uc.card_id AND c.kind = 'interest' AND c.retired_at IS NULL
                           AND (c.visibility <> 'private' OR c.owner_user_id = uc.user_id)
     WHERE uc.user_id = ${userId}::uuid
     ORDER BY c.id`);
  return result.rows.map((row) => ({
    cardId: row.card_id,
    title: row.title,
    strength: row.strength,
    scopeFeedId: row.scope_feed_id,
    interest: row.interest ?? '',
    interestEn: row.interest_en,
    lang: row.lang,
  }));
}

/** The user's labels (label cards held through `user_labels`), in numeric id order. */
export async function loadRankLabels(
  db: Executor,
  userId: string,
): Promise<Array<{ cardId: string; name: string }>> {
  const result = await db.execute<{ card_id: string; name: string }>(sql`
    SELECT l.card_id::text AS card_id, l.name
      FROM user_labels l
      JOIN interest_cards c ON c.id = l.card_id AND c.kind = 'label' AND c.retired_at IS NULL
                           AND (c.visibility <> 'private' OR c.owner_user_id = l.user_id)
     WHERE l.user_id = ${userId}::uuid
     ORDER BY l.card_id`);
  return result.rows.map((row) => ({ cardId: row.card_id, name: row.name }));
}

/** One rule that has not expired at the run's `now` (spec 06 §3.1). */
export interface RankRuleRow {
  id: string;
  kind:
    | 'mute_keyword'
    | 'mute_story'
    | 'block_feed'
    | 'block_domain'
    | 'block_author'
    | 'boost_feed'
    | 'boost_domain';
  value: string;
  expiresAt: Date | null;
}

/** The user's rules that have not expired at `now` (expired rules are excluded, §3.1). */
export async function loadActiveRules(
  db: Executor,
  userId: string,
  now: Date,
): Promise<RankRuleRow[]> {
  const result = await db.execute<{
    id: string;
    kind: RankRuleRow['kind'];
    value: string;
    expires_at: RawTimestamp | null;
  }>(sql`
    SELECT id::text AS id, kind, value, expires_at
      FROM user_rules
     WHERE user_id = ${userId}::uuid
       AND (expires_at IS NULL OR expires_at > ${now.toISOString()}::timestamptz)
     ORDER BY id`);
  return result.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    value: row.value,
    expiresAt: toDateOrNull(row.expires_at),
  }));
}

/** One current dislike inside the auto-demotion window (spec 06 §5). */
export interface RankDislike {
  reason: string | null;
  ratedAt: Date;
  /** `feedback_events.value.staleAtFeedback` of the rating that is in effect; null when unknown. */
  staleAtFeedback: boolean | null;
}

/**
 * The user's current disliked articles rated after `since` (spec 06 §5): one per article from the
 * reader state, so an edited reason moves its count and an undo or unrate removes it. The stale
 * status is the feedback-time snapshot of the latest rating event (`staleAtFeedback`), never
 * recomputed from the article's current facets.
 */
export async function loadRecentDislikes(
  db: Executor,
  userId: string,
  since: Date,
): Promise<RankDislike[]> {
  const result = await db.execute<{
    reason: string | null;
    rated_at: RawTimestamp;
    stale: boolean | null;
  }>(sql`
    SELECT ua.reason, ua.rated_at,
           (SELECT CASE jsonb_typeof(fe.value->'staleAtFeedback')
                     WHEN 'boolean' THEN (fe.value->>'staleAtFeedback')::boolean END
              FROM feedback_events fe
             WHERE fe.user_id = ua.user_id AND fe.article_id = ua.article_id
               AND fe.kind IN ('rate', 'prompt_answer')
             ORDER BY fe.created_at DESC, fe.id DESC LIMIT 1) AS stale
      FROM user_article ua
     WHERE ua.user_id = ${userId}::uuid AND ua.rating = -1
       AND ua.rated_at > ${since.toISOString()}::timestamptz
     ORDER BY ua.rated_at, ua.article_id`);
  return result.rows.map((row) => ({
    reason: row.reason,
    ratedAt: toDate(row.rated_at),
    staleAtFeedback: row.stale,
  }));
}

/**
 * Clusters with a member the user read in the window (spec 06 §7 step 1, §2 step 6i): the reader
 * state, so an unread or undo removes the evidence again.
 */
export async function loadReadClusterIds(
  db: Executor,
  userId: string,
  since: Date,
): Promise<Set<string>> {
  const result = await db.execute<{ cluster_id: string }>(sql`
    SELECT DISTINCT a.story_cluster_id::text AS cluster_id
      FROM user_article ua
      JOIN articles a ON a.id = ua.article_id AND a.story_cluster_id IS NOT NULL
     WHERE ua.user_id = ${userId}::uuid AND ua.read_at IS NOT NULL
       AND ua.read_at >= ${since.toISOString()}::timestamptz`);
  return new Set(result.rows.map((row) => row.cluster_id));
}

/** The ids of the user's held interest cards and labels, as `loadRankCards`/`loadRankLabels` hold them. */
export async function loadHeldCardIds(db: Executor, userId: string): Promise<string[]> {
  const result = await db.execute<{ card_id: string }>(sql`
    SELECT c.id::text AS card_id
      FROM interest_cards c
     WHERE c.retired_at IS NULL
       AND ((c.kind = 'interest' AND EXISTS (
              SELECT 1 FROM user_cards uc WHERE uc.user_id = ${userId}::uuid AND uc.card_id = c.id
                AND (c.visibility <> 'private' OR c.owner_user_id = uc.user_id)))
         OR (c.kind = 'label' AND EXISTS (
              SELECT 1 FROM user_labels l WHERE l.user_id = ${userId}::uuid AND l.card_id = c.id
                AND (c.visibility <> 'private' OR c.owner_user_id = l.user_id))))
     ORDER BY c.id`);
  return result.rows.map((row) => row.card_id);
}
