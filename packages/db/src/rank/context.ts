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
  /**
   * The database clock (ISO, microseconds) read while holding the user row's share lock, i.e. after
   * every reader action that locked the user before the run has committed and before any that
   * locks it later. A reader action marks the rows it makes due with its own `clock_timestamp()`,
   * so a mark newer than `ctxAt` was written by an action the run's context may not include and the
   * run's write must not erase it (S22, `writeRankBatch`).
   */
  ctxAt: string;
}

/** The active (non-deleted) user, or null when the account is gone or being deleted. */
export async function loadRankUser(db: Executor, userId: string): Promise<RankUser | null> {
  // The clock is read in the outer query, over the locked subquery row: the subquery is not pulled
  // up (it has a row mark), so `clock_timestamp()` runs after the share lock was acquired.
  const result = await db.execute<{
    id: string;
    rank_revision: string;
    preferences: unknown;
    ctx_at: string;
  }>(sql`
    SELECT u.id::text AS id, u.rank_revision::text AS rank_revision, u.preferences,
           to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ctx_at
      FROM (SELECT id, rank_revision, preferences FROM users
             WHERE id = ${userId}::uuid AND deleted_at IS NULL FOR SHARE) u`);
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        userId: row.id,
        rankRevision: row.rank_revision,
        preferences: row.preferences,
        ctxAt: row.ctx_at,
      };
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
 * status is the feedback-time snapshot (`staleAtFeedback`) of the rating in effect, whose event has
 * `created_at = rated_at` (an undone re-rate's later event does not count), never recomputed from
 * the article's current facets.
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
               AND fe.kind IN ('rate', 'prompt_answer') AND fe.created_at = ua.rated_at
             ORDER BY fe.id DESC LIMIT 1) AS stale
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

/** One rated article of an interest card's family, with its raw title. */
export interface SimilarFeedbackRow {
  articleId: string;
  rating: 1 | -1;
  ratedAt: Date;
  title: string | null;
}

/** The held card's family key (a private fork shares its parent's), as in library updates. */
const FAMILY = sql`CASE WHEN c.visibility = 'private' THEN coalesce(c.parent_card_id, c.id) ELSE c.id END`;

/**
 * For every positive interest card the user holds, its newest ratings of the last `windowDays` days
 * (likes, and dislikes without a quality reason) on articles that any card of the held card's family
 * answered with `p >= minP`, at most `poolSize` per held card (the input of the similar-dislikes
 * demotion). Keyed by the held card id; `cardIds` limits it to those held cards.
 */
export async function loadSimilarFeedback(
  db: Executor,
  userId: string,
  now: Date,
  limits: { minP: number; windowDays: number; poolSize: number; cardIds?: readonly string[] },
): Promise<Map<string, SimilarFeedbackRow[]>> {
  const since = new Date(now.getTime() - limits.windowDays * 86_400_000);
  const result = await db.execute<{
    held_id: string;
    article_id: string;
    rating: number;
    rated_at: RawTimestamp;
    title: string | null;
  }>(sql`
    WITH held AS (
      SELECT uc.card_id AS id, ${FAMILY} AS family
        FROM user_cards uc
        JOIN interest_cards c ON c.id = uc.card_id AND c.kind = 'interest' AND c.retired_at IS NULL
                             AND (c.visibility <> 'private' OR c.owner_user_id = uc.user_id)
       WHERE uc.user_id = ${userId}::uuid AND uc.strength <> 'never'
         ${limits.cardIds === undefined ? sql`` : sql`AND uc.card_id = ANY(${sql.param([...limits.cardIds])}::bigint[])`}),
    rated AS (
      SELECT ua.article_id, ua.rating, ua.rated_at
        FROM user_article ua
       WHERE ua.user_id = ${userId}::uuid AND ua.rating IN (1, -1)
         AND ua.rated_at > ${since.toISOString()}::timestamptz
         AND (ua.rating = 1 OR ua.reason IS NULL OR ua.reason IN ('off_topic', 'other'))),
    answered AS (
      SELECT DISTINCT r.article_id, ${FAMILY} AS family
        FROM rated r
        JOIN card_answers ca ON ca.article_id = r.article_id AND ca.p >= ${limits.minP}
        JOIN interest_cards c ON c.id = ca.card_id AND c.kind = 'interest'),
    pooled AS (
      SELECT h.id AS held_id, r.article_id, r.rating, r.rated_at,
             row_number() OVER (PARTITION BY h.id ORDER BY r.rated_at DESC, r.article_id DESC) AS n
        FROM held h
        JOIN answered an ON an.family = h.family
        JOIN rated r ON r.article_id = an.article_id)
    SELECT p.held_id::text AS held_id, p.article_id::text AS article_id, p.rating, p.rated_at,
           a.title
      FROM pooled p JOIN articles a ON a.id = p.article_id
     WHERE p.n <= ${limits.poolSize}
     ORDER BY p.held_id, p.n`);
  const map = new Map<string, SimilarFeedbackRow[]>();
  for (const row of result.rows) {
    const rows = map.get(row.held_id) ?? [];
    rows.push({
      articleId: row.article_id,
      rating: row.rating === 1 ? 1 : -1,
      ratedAt: toDate(row.rated_at),
      title: row.title,
    });
    map.set(row.held_id, rows);
  }
  return map;
}

/**
 * Clusters with a member the user read in the window (spec 06 §7 step 1, §2 step 6i), each with the
 * time of its latest such read: the reader state, so an unread or undo removes the evidence again,
 * and the seen state can end at `latest read + window` (S22).
 */
export async function loadReadClusterIds(
  db: Executor,
  userId: string,
  since: Date,
): Promise<Map<string, Date>> {
  const result = await db.execute<{ cluster_id: string; read_at: RawTimestamp }>(sql`
    SELECT a.story_cluster_id::text AS cluster_id, max(ua.read_at) AS read_at
      FROM user_article ua
      JOIN articles a ON a.id = ua.article_id AND a.story_cluster_id IS NOT NULL
     WHERE ua.user_id = ${userId}::uuid AND ua.read_at IS NOT NULL
       AND ua.read_at >= ${since.toISOString()}::timestamptz
     GROUP BY a.story_cluster_id`);
  return new Map(result.rows.map((row) => [row.cluster_id, toDate(row.read_at)]));
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
