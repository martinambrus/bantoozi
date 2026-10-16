import { sql } from 'drizzle-orm';

import type { Executor } from '../client.js';
import { SELECTION_WINDOW_DAYS } from '../ingest/demand.js';
import { MATCH_MAX_ATTEMPTS, MATCH_RECOVERY_COOLDOWN_MS } from './match-claims.js';

/** A keyset cursor over `(key, articleId)` descending, persisted in `settings['house.progress']`. */
export interface RecoveryCursor {
  key: string;
  articleId: string;
}

/** One recoverable article: its latest eligible carrier arrival is the page key. */
export interface RecoveryArticle {
  articleId: string;
  revision: string;
  pipelineState: string;
  enrichEngine: string | null;
  key: string;
}

/**
 * Eligible arrivals of an article (spec 04 §5: feed membership time, not the global article time):
 * an `active` subscription's carrier that arrived at/after activation (non-stale article), or a
 * current selected request's carrier. Reused by the recovery queries below.
 */
const eligibleArrivals = sql`
  SELECT fi.article_id, fi.first_seen_at
    FROM feed_items fi
    JOIN articles a ON a.id = fi.article_id AND a.pipeline_state <> 'stale'
    JOIN subscriptions s ON s.feed_id = fi.feed_id AND s.inference_mode = 'active'
                        AND fi.first_seen_at >= s.inference_activated_at AND fi.over_cap_limit IS NULL
    JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL
  UNION
  SELECT fi.article_id, fi.first_seen_at
    FROM analysis_requests r
    JOIN articles a ON a.id = r.article_id AND a.content_revision = r.article_revision
    JOIN feed_items fi ON fi.article_id = r.article_id AND fi.feed_id = r.feed_id
    JOIN subscriptions s ON s.user_id = r.user_id AND s.feed_id = r.feed_id
                        AND s.inference_mode IN ('training', 'active')
                        AND s.inference_version = r.inference_version
    JOIN users u ON u.id = r.user_id AND u.deleted_at IS NULL
   WHERE r.status IN ('pending', 'running', 'complete')
     AND r.created_at > now() - make_interval(days => ${SELECTION_WINDOW_DAYS})`;

/**
 * Articles whose Call A needs recovery (spec 04 §5 `house.rescore-degraded`): `degraded` ones, and
 * ones enriched by the LLM fallback (their answers are replaced by the primary engine), whose latest
 * eligible carrier arrival lies within `windowDays` and whose demand is still authorized, newest
 * first strictly below `cursor`. `failed` (invalid request) and stale articles are never revived,
 * and neither is an LLM-enriched article whose current revision Jev already rejected as an invalid
 * request under the active enrich set `enrichSetId` (it keeps its fallback answers; spec 03 §2.2:
 * persistent invalid input does not loop).
 */
export async function enrichRecoveryPage(
  db: Executor,
  input: { windowDays: number; cursor?: RecoveryCursor; limit: number; enrichSetId: string | null },
): Promise<RecoveryArticle[]> {
  const below =
    input.cursor === undefined
      ? sql``
      : sql`AND (e.key, e.article_id) < (${input.cursor.key}::timestamptz, ${input.cursor.articleId}::bigint)`;
  const result = await db.execute<{
    article_id: string;
    revision: string;
    pipeline_state: string;
    enrich_engine: string | null;
    key: string;
  }>(sql`
    SELECT e.article_id::text AS article_id, a.content_revision::text AS revision,
           a.pipeline_state, a.enrich_engine,
           to_char(e.key AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS key
      FROM (SELECT article_id, max(first_seen_at) AS key FROM (${eligibleArrivals}) x
             GROUP BY article_id) e
      JOIN articles a ON a.id = e.article_id
     WHERE (a.pipeline_state = 'degraded'
            OR (a.enrich_engine = 'llm' AND a.pipeline_state IN ('enriched', 'matched')
                AND NOT EXISTS (
                  SELECT 1 FROM engine_calls c
                   WHERE c.article_id = a.id AND c.article_revision = a.content_revision
                     AND c.kind = 'enrich' AND c.engine = 'typesafe'
                     AND c.status = 'invalid_request'
                     AND c.question_set_id = ${input.enrichSetId}::bigint)))
       AND e.key >= now() - make_interval(days => ${input.windowDays})
       ${below}
     ORDER BY e.key DESC, e.article_id DESC
     LIMIT ${input.limit}`);
  return result.rows.map((row) => ({
    articleId: row.article_id,
    revision: row.revision,
    pipelineState: row.pipeline_state,
    enrichEngine: row.enrich_engine,
    key: row.key,
  }));
}

/**
 * Articles with provisional LLM card or level-2 answers at their current revision, primary facets,
 * an eligible arrival within the window and still-authorized demand (spec 04 §5: recovery requeues
 * current LLM answers even when Call A already succeeded with the primary engine). Returns the
 * article ids with the LLM-answered card ids, newest first strictly below `cursor`.
 */
export async function llmAnswerRecoveryPage(
  db: Executor,
  input: { windowDays: number; cursor?: RecoveryCursor; limit: number },
): Promise<Array<RecoveryArticle & { llmCardIds: string[]; llmL2: boolean }>> {
  const below =
    input.cursor === undefined
      ? sql``
      : sql`AND (e.key, e.article_id) < (${input.cursor.key}::timestamptz, ${input.cursor.articleId}::bigint)`;
  const result = await db.execute<{
    article_id: string;
    revision: string;
    pipeline_state: string;
    enrich_engine: string | null;
    key: string;
    llm_card_ids: string[];
    llm_l2: boolean;
  }>(sql`
    SELECT e.article_id::text AS article_id, a.content_revision::text AS revision,
           a.pipeline_state, a.enrich_engine,
           to_char(e.key AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS key,
           coalesce((SELECT array_agg(ca.card_id::text ORDER BY ca.card_id) FROM card_answers ca
                      WHERE ca.article_id = a.id AND ca.article_revision = a.content_revision
                        AND ca.engine = 'llm'), '{}') AS llm_card_ids,
           EXISTS (SELECT 1 FROM article_topics_l2 t
                    WHERE t.article_id = a.id AND t.article_revision = a.content_revision
                      AND t.engine = 'llm') AS llm_l2
      FROM (SELECT article_id, max(first_seen_at) AS key FROM (${eligibleArrivals}) x
             GROUP BY article_id) e
      JOIN articles a ON a.id = e.article_id
     WHERE a.pipeline_state IN ('enriched', 'matched')
       AND a.enrich_engine IS DISTINCT FROM 'llm'
       AND e.key >= now() - make_interval(days => ${input.windowDays})
       AND (EXISTS (SELECT 1 FROM card_answers ca
                     WHERE ca.article_id = a.id AND ca.article_revision = a.content_revision
                       AND ca.engine = 'llm')
            OR EXISTS (SELECT 1 FROM article_topics_l2 t
                        WHERE t.article_id = a.id AND t.article_revision = a.content_revision
                          AND t.engine = 'llm'))
       ${below}
     ORDER BY e.key DESC, e.article_id DESC
     LIMIT ${input.limit}`);
  return result.rows.map((row) => ({
    articleId: row.article_id,
    revision: row.revision,
    pipelineState: row.pipeline_state,
    enrichEngine: row.enrich_engine,
    key: row.key,
    llmCardIds: row.llm_card_ids,
    llmL2: row.llm_l2,
  }));
}

/**
 * Retained `match_queue` work whose blocker may have lifted (spec 11 §6, spec 05 §5.5 step 7). The
 * caller runs this only while the primary engine is available. Rows exhausted by service failures
 * (their `last_error` names no invalid request) get their attempts reset in a bounded batch once
 * `cooldownMs` has passed since they gave up (`next_attempt_at` of an exhausted row), so a pair
 * that keeps failing is not rebilled on every pass. The articles with due, unleased rows at their
 * current revision are returned so the caller can dispatch `article.match`. Permanent invalid
 * requests stay exhausted.
 */
export async function recoverMatchQueue(
  db: Executor,
  input: { limit: number; cooldownMs?: number },
): Promise<{ resetRows: number; articleIds: string[] }> {
  const cooldownSeconds = (input.cooldownMs ?? MATCH_RECOVERY_COOLDOWN_MS) / 1000;
  const reset = await db.execute(sql`
    UPDATE match_queue q SET attempts = 0, next_attempt_at = now(), last_error = NULL
      FROM (SELECT q2.article_id, q2.card_id
              FROM match_queue q2
              JOIN articles a ON a.id = q2.article_id AND q2.article_revision = a.content_revision
                             AND a.pipeline_state IN ('enriched', 'matched')
             WHERE q2.attempts >= ${MATCH_MAX_ATTEMPTS}
               AND (q2.lease_until IS NULL OR q2.lease_until < now())
               AND coalesce(q2.last_error, '') NOT LIKE 'invalid_request%'
               AND q2.next_attempt_at <= now() - make_interval(secs => ${cooldownSeconds}::double precision)
             ORDER BY q2.enqueued_at, q2.article_id, q2.card_id
             LIMIT ${input.limit}
             FOR UPDATE OF q2 SKIP LOCKED) x
     WHERE q.article_id = x.article_id AND q.card_id = x.card_id`);
  const due = await db.execute<{ article_id: string }>(sql`
    SELECT q.article_id::text AS article_id, min(q.enqueued_at) AS oldest
      FROM match_queue q
      JOIN articles a ON a.id = q.article_id AND a.content_revision = q.article_revision
                     AND a.pipeline_state IN ('enriched', 'matched')
     WHERE q.attempts < ${MATCH_MAX_ATTEMPTS} AND q.next_attempt_at <= now()
       AND (q.lease_until IS NULL OR q.lease_until < now())
     GROUP BY q.article_id
     ORDER BY 2, 1
     LIMIT ${input.limit}`);
  return { resetRows: reset.rowCount ?? 0, articleIds: due.rows.map((row) => row.article_id) };
}

/** Age after which an unclaimable `match_queue` row is swept (D-254). */
export const STALLED_MATCH_ROW_AGE_MS = 60 * 60_000;

/**
 * Deletes up to `limit` `match_queue` rows that can never run (D-254, the D-70 repair). Claims run
 * after enrichment, so a row on an `extracted`/`translated` article waits for a stage nothing will
 * start when the article's only demand is a frozen selection (or it has none: unsubscribed, mode
 * off, a bumped inference version). A row qualifies when it is unleased, was enqueued at least
 * `olderThanMs` ago, its article is `extracted`/`translated`, no `active` subscription admits an
 * arrival of the article (such an article is on its way to enrichment), and no undelivered
 * extract/translate/enrich/match intent exists for the article. Returns the number deleted and the
 * users whose stored ranking may carry a `pending_cards` demotion from a deleted row, so the caller
 * can re-rank them: the row's own `user_id`, and for a shared row (`user_id` NULL) every live user
 * who subscribes to a feed carrying the article or has an analysis request for it.
 */
export async function sweepStalledMatchRows(
  db: Executor,
  input: { limit: number; olderThanMs?: number },
): Promise<{ deleted: number; userIds: string[] }> {
  const olderSeconds = (input.olderThanMs ?? STALLED_MATCH_ROW_AGE_MS) / 1000;
  const result = await db.execute<{ article_id: string; user_id: string | null }>(sql`
    DELETE FROM match_queue q
     USING (SELECT q2.article_id, q2.card_id
              FROM match_queue q2
              JOIN articles a ON a.id = q2.article_id
                             AND a.pipeline_state IN ('extracted', 'translated')
             WHERE q2.enqueued_at < now() - make_interval(secs => ${olderSeconds}::double precision)
               AND (q2.lease_until IS NULL OR q2.lease_until < now())
               AND NOT EXISTS (
                     SELECT 1 FROM feed_items fi
                       JOIN subscriptions s ON s.feed_id = fi.feed_id AND s.inference_mode = 'active'
                                           AND fi.first_seen_at >= s.inference_activated_at
                                           AND fi.over_cap_limit IS NULL
                       JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL
                      WHERE fi.article_id = q2.article_id)
               AND NOT EXISTS (
                     SELECT 1 FROM job_outbox o
                      WHERE o.delivered_at IS NULL
                        AND o.queue IN ('article.extract', 'article.translate', 'article.enrich',
                                        'article.match')
                        AND o.payload->>'articleId' = q2.article_id::text)
             ORDER BY q2.enqueued_at, q2.article_id, q2.card_id
             LIMIT ${input.limit}
             FOR UPDATE OF q2 SKIP LOCKED) x
     WHERE q.article_id = x.article_id AND q.card_id = x.card_id
    RETURNING q.article_id::text AS article_id, q.user_id::text AS user_id`);
  const users = new Set<string>();
  const shared = new Set<string>();
  for (const row of result.rows) {
    if (row.user_id === null) shared.add(row.article_id);
    else users.add(row.user_id);
  }
  if (shared.size > 0) {
    const affected = await db.execute<{ user_id: string }>(sql`
      SELECT s.user_id::text AS user_id
        FROM feed_items fi
        JOIN subscriptions s ON s.feed_id = fi.feed_id
       WHERE fi.article_id = ANY(${sql.param([...shared])}::bigint[])
      UNION
      SELECT r.user_id::text FROM analysis_requests r
       WHERE r.article_id = ANY(${sql.param([...shared])}::bigint[])`);
    for (const row of affected.rows) users.add(row.user_id);
  }
  return { deleted: result.rowCount ?? 0, userIds: [...users].sort() };
}
