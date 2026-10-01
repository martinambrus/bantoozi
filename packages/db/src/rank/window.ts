import { sql, type SQL } from 'drizzle-orm';

import type { Executor } from '../client.js';
import { SELECTION_WINDOW_DAYS } from '../ingest/demand.js';

/**
 * The user's rank window (spec 06 §7 step 2): articles carried by the user's subscriptions whose
 * latest subscribed carrier arrived within `RANK_WINDOW_DAYS` (`feed_items.first_seen_at`, as in the
 * API list window, spec 08 §5.1), plus, whatever their arrival, articles the user explicitly selected
 * whose request completed at the current revision inside the 180-day selection window (spec 05
 * §1.1). Articles the user archived are left out. Keyed by `(arrival, id)`, newest first.
 */

/** A keyset position: the last visited `(arrival, articleId)`, exclusive. */
export interface RankCursor {
  /** ISO timestamp with microseconds (the exact database value). */
  arrival: string;
  articleId: string;
}

export interface RankWindowInput {
  userId: string;
  /** The run's single captured `now`. */
  now: Date;
  windowDays: number;
}

function windowCte(input: RankWindowInput): SQL {
  const cutoff = new Date(input.now.getTime() - input.windowDays * 86_400_000).toISOString();
  const selectionCutoff = new Date(
    input.now.getTime() - SELECTION_WINDOW_DAYS * 86_400_000,
  ).toISOString();
  return sql`
    subs AS (SELECT feed_id FROM subscriptions WHERE user_id = ${input.userId}::uuid),
    recent AS (
      SELECT fi.article_id, max(fi.first_seen_at) AS arrival
        FROM feed_items fi JOIN subs s ON s.feed_id = fi.feed_id
       WHERE fi.first_seen_at >= ${cutoff}::timestamptz
       GROUP BY fi.article_id),
    selected AS (
      SELECT DISTINCT r.article_id
        FROM analysis_requests r
        JOIN articles a ON a.id = r.article_id AND a.content_revision = r.article_revision
        JOIN subscriptions s ON s.user_id = r.user_id AND s.feed_id = r.feed_id
                            AND s.inference_mode IN ('training', 'active')
                            AND s.inference_version = r.inference_version
        JOIN feed_items fi ON fi.article_id = r.article_id AND fi.feed_id = r.feed_id
       WHERE r.user_id = ${input.userId}::uuid AND r.status = 'complete'
         AND r.created_at > ${selectionCutoff}::timestamptz
         AND r.article_id NOT IN (SELECT article_id FROM recent)),
    rank_window AS (
      SELECT article_id, arrival FROM recent
      UNION ALL
      SELECT s.article_id,
             coalesce((SELECT max(fi.first_seen_at) FROM feed_items fi JOIN subs x
                         ON x.feed_id = fi.feed_id WHERE fi.article_id = s.article_id),
                      a.first_seen_at)
        FROM selected s JOIN articles a ON a.id = s.article_id)`;
}

/**
 * The inference admission of spec 05 §1.1 for this user and article `a` at its current revision: an
 * `active` subscription to a carrier that arrived at/after activation (a non-stale article), or a
 * current selected request (pending, running or complete) at the current revision.
 */
function admitted(userId: string, now: Date): SQL {
  const selectionCutoff = new Date(
    now.getTime() - SELECTION_WINDOW_DAYS * 86_400_000,
  ).toISOString();
  return sql`(
    (a.pipeline_state <> 'stale' AND EXISTS (
       SELECT 1 FROM feed_items fi
         JOIN subscriptions s ON s.feed_id = fi.feed_id AND s.user_id = ${userId}::uuid
                             AND s.inference_mode = 'active'
                             AND fi.first_seen_at >= s.inference_activated_at
        WHERE fi.article_id = a.id))
    OR EXISTS (
       SELECT 1 FROM analysis_requests r
         JOIN subscriptions s ON s.user_id = r.user_id AND s.feed_id = r.feed_id
                             AND s.inference_mode IN ('training', 'active')
                             AND s.inference_version = r.inference_version
         JOIN feed_items fi ON fi.article_id = r.article_id AND fi.feed_id = r.feed_id
        WHERE r.user_id = ${userId}::uuid AND r.article_id = a.id
          AND r.article_revision = a.content_revision
          AND r.status IN ('pending', 'running', 'complete')
          AND r.created_at > ${selectionCutoff}::timestamptz))`;
}

/** What makes a stored ranking current (spec 06 §7 step 2). */
export interface RankStampInput extends RankWindowInput {
  scoreVersion: string;
  rankRevision: string;
  /** `explain.inputs.contextSha` of non-degraded and of degraded results. */
  contextSha: string;
  degradedContextSha: string;
  /** The active enrich set; facets of another set are not inputs. */
  enrichSetId: string | null;
  /**
   * How far before `scored_at` an input timestamp still asks for a recheck: an input written by a
   * transaction that started before the run's snapshot can commit after it with an older timestamp.
   * Inputs are compared with `scored_at` at its millisecond precision for dirtiness (the run's
   * `now` is a JavaScript date), so an input stamped later within that millisecond is rechecked.
   */
  recheckMarginMs: number;
  /**
   * A full run (spec 06 §7 step 2 `full: true`): rows scored before this time are dirty whatever
   * their stamps. A full run passes its own snapshot time and its continuations the original one,
   * so the rows the run already wrote are not ranked again.
   */
  forceBefore?: Date | undefined;
}

/** One window article of a dirty-set page. */
export interface RankWindowRow {
  articleId: string;
  arrival: string;
  /**
   * The stored ranking is outdated (spec 06 §7 step 2): no row; another score version or rank
   * revision; a due `next_rank_at`; other content/media revisions or context than its explanation
   * records; or an input (facets, the user's card and label answers, translations, the article's
   * pipeline/cluster state, the cluster, a carrier arrival) newer than `scored_at`.
   */
  dirty: boolean;
  /**
   * The ranking may be outdated without a durable sign: an input written shortly before
   * `scored_at`, or an unscored item waiting on queued card work (its coverage can become
   * unavailable without a new answer). It is re-ranked and written only when the result changes.
   */
  recheck: boolean;
}

/**
 * One keyset page of the window with each article's dirty and recheck flags, newest first, strictly
 * below `cursor`. A page holds `limit` articles whatever their flags, so a run visits the whole
 * window in bounded pages.
 */
export async function rankWindowPage(
  db: Executor,
  input: RankStampInput & { cursor?: RankCursor | undefined; limit: number },
): Promise<RankWindowRow[]> {
  const below =
    input.cursor === undefined
      ? sql``
      : sql`AND (w.arrival, w.article_id) < (${input.cursor.arrival}::timestamptz, ${input.cursor.articleId}::bigint)`;
  const marginSeconds = input.recheckMarginMs / 1000;
  const force =
    input.forceBefore === undefined
      ? sql``
      : sql`OR ua.scored_at < ${input.forceBefore.toISOString()}::timestamptz`;
  const result = await db.execute<{
    article_id: string;
    arrival: string;
    dirty: boolean;
    recheck: boolean;
  }>(sql`
    WITH ${windowCte(input)},
    held AS (SELECT card_id FROM user_cards WHERE user_id = ${input.userId}::uuid
             UNION SELECT card_id FROM user_labels WHERE user_id = ${input.userId}::uuid)
    SELECT w.article_id::text AS article_id,
           to_char(w.arrival AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS arrival,
           (ua.user_id IS NULL OR ua.scored_at IS NULL OR ua.explain IS NULL
            OR ua.score_version <> ${input.scoreVersion}
            OR ua.rank_revision <> ${input.rankRevision}::bigint
            OR ua.next_rank_at <= ${input.now.toISOString()}::timestamptz
            OR (ua.explain->'inputs'->>'contentRevision') IS DISTINCT FROM a.content_revision::text
            OR (ua.explain->'inputs'->>'mediaRevision') IS DISTINCT FROM a.media_revision::text
            OR (ua.explain->'inputs'->>'contextSha') IS DISTINCT FROM
               (CASE WHEN ua.score_source = 'degraded' THEN ${input.degradedContextSha}
                     ELSE ${input.contextSha} END)
            OR ua.scored_at < date_trunc('milliseconds', i.input_at) ${force}) IS TRUE AS dirty,
           (ua.scored_at < i.input_at + make_interval(secs => ${marginSeconds}::double precision)
            OR (ua.lane = 'new' AND ua.score_source = 'none'
                AND NOT ('inference_not_requested' = ANY(ua.rules_fired))
                AND EXISTS (SELECT 1 FROM match_queue q
                             WHERE q.article_id = a.id AND q.article_revision = a.content_revision
                               AND q.card_id IN (SELECT card_id FROM held)))) IS TRUE AS recheck
      FROM rank_window w
      JOIN articles a ON a.id = w.article_id
      LEFT JOIN user_article ua ON ua.user_id = ${input.userId}::uuid AND ua.article_id = w.article_id
      LEFT JOIN story_clusters sc ON sc.id = a.story_cluster_id
      CROSS JOIN LATERAL (SELECT greatest(
        a.updated_at, w.arrival, sc.updated_at,
        (SELECT max(f.updated_at) FROM article_facets f
          WHERE f.article_id = a.id AND f.question_set_id = ${input.enrichSetId}::bigint),
        (SELECT max(ca.answered_at) FROM card_answers ca
          WHERE ca.article_id = a.id AND ca.card_id IN (SELECT card_id FROM held)),
        (SELECT max(t.created_at) FROM article_translations t WHERE t.article_id = a.id)
      ) AS input_at) i
     WHERE (ua.archived_at IS NULL) ${below}
     ORDER BY w.arrival DESC, w.article_id DESC
     LIMIT ${input.limit}`);
  return result.rows.map((row) => ({
    articleId: row.article_id,
    arrival: row.arrival,
    dirty: row.dirty,
    recheck: row.recheck,
  }));
}

/**
 * One document of the BM25 corpus (spec 06 §7 step 1, §9), which holds every inference-eligible
 * window article, not just the dirty ones (archived articles are outside the window). The caller selects the translation and normalizes it.
 */
export interface RankCorpusArticle {
  articleId: string;
  revision: string;
  lang: string | null;
  titleNorm: string;
  excerpt: string | null;
}

/** A page of the corpus articles (id order, strictly above `afterId`). */
export async function rankCorpusPage(
  db: Executor,
  input: RankWindowInput & { afterId?: string; limit: number },
): Promise<RankCorpusArticle[]> {
  const after = input.afterId === undefined ? sql`` : sql`AND a.id > ${input.afterId}::bigint`;
  const result = await db.execute<{
    id: string;
    revision: string;
    lang: string | null;
    title_norm: string;
    excerpt: string | null;
  }>(sql`
    WITH ${windowCte(input)}
    SELECT a.id::text AS id, a.content_revision::text AS revision, a.lang, a.title_norm, a.excerpt
      FROM rank_window w
      JOIN articles a ON a.id = w.article_id
      LEFT JOIN user_article ua ON ua.user_id = ${input.userId}::uuid AND ua.article_id = w.article_id
     WHERE ua.archived_at IS NULL AND ${admitted(input.userId, input.now)} ${after}
     ORDER BY a.id
     LIMIT ${input.limit}`);
  return result.rows.map((row) => ({
    articleId: row.id,
    revision: row.revision,
    lang: row.lang,
    titleNorm: row.title_norm,
    excerpt: row.excerpt,
  }));
}
