import { sql } from 'drizzle-orm';

import type { Executor } from '../client.js';
import { SELECTION_WINDOW_DAYS } from '../ingest/demand.js';
import { MATCH_MAX_ATTEMPTS } from './match-claims.js';

/** A keyset position `(latest eligible arrival, article id)`, descending. */
export interface ReprocessCursor {
  key: string;
  articleId: string;
}

/** One article of a reprocessing window, with its facets under the active enrich set. */
export interface ReprocessArticle {
  articleId: string;
  revision: string;
  pipelineState: string;
  lang: string | null;
  key: string;
  facets: {
    revision: string;
    engine: string;
    model: string | null;
    stateVariant: 'native' | 'translated';
  } | null;
}

/**
 * One page of the still-demanded window of an on-demand rebuild (spec 05 §2, spec 11 §6): articles
 * whose latest eligible carrier arrival (active subscription, at/after activation, non-stale
 * article) is at/after `since`, plus articles with a current completed selected request whatever
 * their arrival, in `states`, newest first strictly below `cursor`. `lang` and `cardId` (articles
 * with a stored answer of that card) and `skippedReasons` (a current tier-2 row skipped for one of
 * them, spec 07 §3) narrow the page; `enrichSetId` selects the facets returned.
 */
export async function reprocessWindowPage(
  db: Executor,
  input: {
    since: string;
    cursor?: ReprocessCursor;
    limit: number;
    states: readonly string[];
    enrichSetId: string | null;
    lang?: string;
    cardId?: string;
    skippedReasons?: readonly string[];
  },
): Promise<ReprocessArticle[]> {
  const below =
    input.cursor === undefined
      ? sql``
      : sql`AND (e.key, e.article_id) < (${input.cursor.key}::timestamptz, ${input.cursor.articleId}::bigint)`;
  const lang = input.lang === undefined ? sql`` : sql`AND a.lang = ${input.lang}`;
  const card =
    input.cardId === undefined
      ? sql``
      : sql`AND EXISTS (SELECT 1 FROM card_answers ca
                         WHERE ca.article_id = a.id AND ca.card_id = ${input.cardId}::bigint)`;
  const skipped =
    input.skippedReasons === undefined
      ? sql``
      : sql`AND EXISTS (SELECT 1 FROM article_translations t
                         WHERE t.article_id = a.id AND t.article_revision = a.content_revision
                           AND t.engine = 'ollama'
                           AND t.quality_detail->>'skipped' = ANY(${sql.param([...input.skippedReasons])}::text[]))`;
  const result = await db.execute<{
    article_id: string;
    revision: string;
    pipeline_state: string;
    lang: string | null;
    key: string;
    facet_revision: string | null;
    facet_engine: string | null;
    facet_model: string | null;
    facet_variant: 'native' | 'translated' | null;
  }>(sql`
    WITH arrivals AS (
      SELECT fi.article_id, fi.first_seen_at AS seen, false AS selected
        FROM feed_items fi
        JOIN articles a ON a.id = fi.article_id AND a.pipeline_state <> 'stale'
        JOIN subscriptions s ON s.feed_id = fi.feed_id AND s.inference_mode = 'active'
                            AND fi.first_seen_at >= s.inference_activated_at
        JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL
      UNION ALL
      SELECT fi.article_id, fi.first_seen_at, true
        FROM analysis_requests r
        JOIN articles a ON a.id = r.article_id AND a.content_revision = r.article_revision
        JOIN feed_items fi ON fi.article_id = r.article_id AND fi.feed_id = r.feed_id
        JOIN subscriptions s ON s.user_id = r.user_id AND s.feed_id = r.feed_id
                            AND s.inference_mode IN ('training', 'active')
                            AND s.inference_version = r.inference_version
        JOIN users u ON u.id = r.user_id AND u.deleted_at IS NULL
       WHERE r.status = 'complete'
         AND r.created_at > now() - make_interval(days => ${SELECTION_WINDOW_DAYS})
    ), e AS (
      SELECT article_id, max(seen) AS key FROM arrivals GROUP BY article_id
      HAVING bool_or(selected)
          OR max(seen) FILTER (WHERE NOT selected) >= ${input.since}::timestamptz
    )
    SELECT e.article_id::text AS article_id, a.content_revision::text AS revision,
           a.pipeline_state, a.lang,
           to_char(e.key AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS key,
           f.article_revision::text AS facet_revision, f.engine AS facet_engine,
           f.model AS facet_model, f.state_variant AS facet_variant
      FROM e
      JOIN articles a ON a.id = e.article_id
      LEFT JOIN article_facets f ON f.article_id = a.id
                                AND f.question_set_id = ${input.enrichSetId}::bigint
     WHERE a.pipeline_state = ANY(${sql.param([...input.states])}::text[])
       ${lang} ${card} ${skipped} ${below}
     ORDER BY e.key DESC, e.article_id DESC
     LIMIT ${input.limit}`);
  return result.rows.map((row) => ({
    articleId: row.article_id,
    revision: row.revision,
    pipelineState: row.pipeline_state,
    lang: row.lang,
    key: row.key,
    facets:
      row.facet_revision === null || row.facet_engine === null || row.facet_variant === null
        ? null
        : {
            revision: row.facet_revision,
            engine: row.facet_engine,
            model: row.facet_model,
            stateVariant: row.facet_variant,
          },
  }));
}

/**
 * Give exhausted `invalid_request` rows of `articleId` at `revision` another chance (spec 05 §5.5
 * step 7): the caller found their stored answers incompatible because the model, the card text or
 * the question set changed, so the blocker that exhausted them may be gone. Returns the rows reset.
 */
export async function reviveInvalidMatchRows(
  db: Executor,
  articleId: string,
  revision: string,
  cardIds: readonly string[],
): Promise<number> {
  if (cardIds.length === 0) return 0;
  const result = await db.execute(sql`
    UPDATE match_queue
       SET attempts = 0, next_attempt_at = now(), last_error = NULL, lease_token = NULL,
           lease_until = NULL
     WHERE article_id = ${articleId}::bigint AND article_revision = ${revision}::bigint
       AND card_id = ANY(${sql.param([...cardIds])}::bigint[])
       AND attempts >= ${MATCH_MAX_ATTEMPTS}
       AND coalesce(last_error, '') LIKE 'invalid_request%'
       AND (lease_until IS NULL OR lease_until < now())`);
  return result.rowCount ?? 0;
}

/**
 * Tier-2 translation calls reserved or made today (UTC): the count the daily cap
 * `translate.tier2_daily_cap` is checked against (spec 07 §3, spec 04 §6).
 */
export async function tier2CallsToday(db: Executor): Promise<number> {
  const result = await db.execute<{ calls: number }>(sql`
    SELECT coalesce(sum(reserved_calls), 0)::int AS calls
      FROM engine_reservations
     WHERE day = (now() AT TIME ZONE 'UTC')::date AND engine = 'llm' AND kind = 'translate'`);
  return result.rows[0]?.calls ?? 0;
}
