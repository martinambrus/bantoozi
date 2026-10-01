import { sql } from 'drizzle-orm';

import type { Executor } from '../client.js';
import { SELECTION_WINDOW_DAYS } from '../ingest/demand.js';
import { toDate, toDateOrNull, type RawTimestamp } from '../timestamps.js';

/**
 * Batch loads of the rank handler (spec 06 §7 step 3) for one page of articles: everything
 * `RankItem` needs besides the classification inputs (`loadClassificationArticles`), plus the stored
 * ranking row the run compares with. Each query returns rows for the given ids only.
 */

/** Per-article facts of one user and article. */
export interface RankArticleFacts {
  articleId: string;
  revision: string;
  mediaRevision: string;
  hasVideo: boolean | null;
  bodyImageCount: number | null;
  hasImage: boolean;
  /** `articles.url`, else the canonical URL: the source of the registrable domain. */
  url: string;
  clusterSize: number | null;
  /** All carriers of the article that the user subscribes to (manual rules, spec 06 §1). */
  feedIds: string[];
  /** The carriers admitted for inference for this user and revision (spec 05 §1.1). */
  inferenceFeedIds: string[];
  /** A current selected request (pending, running or complete) authorizes this revision. */
  explicitSelection: boolean;
}

export async function loadRankArticleFacts(
  db: Executor,
  input: { userId: string; articleIds: readonly string[]; now: Date },
): Promise<Map<string, RankArticleFacts>> {
  if (input.articleIds.length === 0) return new Map();
  const selectionCutoff = new Date(
    input.now.getTime() - SELECTION_WINDOW_DAYS * 86_400_000,
  ).toISOString();
  const result = await db.execute<{
    id: string;
    revision: string;
    media_revision: string;
    has_video: boolean | null;
    body_image_count: number | null;
    has_image: boolean;
    url: string;
    cluster_size: number | null;
    feed_ids: string[];
    automatic_ids: string[];
    selected_ids: string[];
  }>(sql`
    SELECT a.id::text AS id, a.content_revision::text AS revision,
           a.media_revision::text AS media_revision, a.has_video, a.body_image_count,
           (a.image_url IS NOT NULL) AS has_image, coalesce(a.url, a.canonical_url) AS url,
           sc.size AS cluster_size,
           coalesce((SELECT array_agg(fi.feed_id::text ORDER BY fi.feed_id)
                       FROM feed_items fi
                       JOIN subscriptions s ON s.feed_id = fi.feed_id AND s.user_id = ${input.userId}::uuid
                      WHERE fi.article_id = a.id), '{}') AS feed_ids,
           coalesce((SELECT array_agg(fi.feed_id::text ORDER BY fi.feed_id)
                       FROM feed_items fi
                       JOIN subscriptions s ON s.feed_id = fi.feed_id AND s.user_id = ${input.userId}::uuid
                                           AND s.inference_mode = 'active'
                                           AND fi.first_seen_at >= s.inference_activated_at
                      WHERE fi.article_id = a.id AND a.pipeline_state <> 'stale'), '{}') AS automatic_ids,
           coalesce((SELECT array_agg(DISTINCT r.feed_id::text)
                       FROM analysis_requests r
                       JOIN subscriptions s ON s.user_id = r.user_id AND s.feed_id = r.feed_id
                                           AND s.inference_mode IN ('training', 'active')
                                           AND s.inference_version = r.inference_version
                       JOIN feed_items fi ON fi.article_id = r.article_id AND fi.feed_id = r.feed_id
                      WHERE r.user_id = ${input.userId}::uuid AND r.article_id = a.id
                        AND r.article_revision = a.content_revision
                        AND r.status IN ('pending', 'running', 'complete')
                        AND r.created_at > ${selectionCutoff}::timestamptz), '{}') AS selected_ids
      FROM articles a
      LEFT JOIN story_clusters sc ON sc.id = a.story_cluster_id
     WHERE a.id = ANY(${sql.param([...input.articleIds])}::bigint[])`);
  return new Map(
    result.rows.map((row) => {
      const inference = [...new Set([...row.automatic_ids, ...row.selected_ids])].sort((x, y) =>
        BigInt(x) < BigInt(y) ? -1 : BigInt(x) > BigInt(y) ? 1 : 0,
      );
      return [
        row.id,
        {
          articleId: row.id,
          revision: row.revision,
          mediaRevision: row.media_revision,
          hasVideo: row.has_video,
          bodyImageCount: row.body_image_count,
          hasImage: row.has_image,
          url: row.url,
          clusterSize: row.cluster_size,
          feedIds: row.feed_ids,
          inferenceFeedIds: inference,
          explicitSelection: row.selected_ids.length > 0,
        },
      ];
    }),
  );
}

/** Current facets of the active enrich set (spec 05 §3.4) at the article's current revision. */
export async function loadRankFacets(
  db: Executor,
  input: { articleIds: readonly string[]; enrichSetId: string | null },
): Promise<Map<string, Record<string, number>>> {
  if (input.articleIds.length === 0 || input.enrichSetId === null) return new Map();
  const result = await db.execute<{ article_id: string; features: Record<string, number> }>(sql`
    SELECT f.article_id::text AS article_id, f.features
      FROM article_facets f
      JOIN articles a ON a.id = f.article_id AND a.content_revision = f.article_revision
     WHERE f.article_id = ANY(${sql.param([...input.articleIds])}::bigint[])
       AND f.question_set_id = ${input.enrichSetId}::bigint`);
  return new Map(result.rows.map((row) => [row.article_id, row.features]));
}

/** A stored card answer with the fingerprint the handler checks (spec 06 §2). */
export interface RankAnswerRow {
  articleId: string;
  cardId: string;
  p: number;
  engine: 'typesafe' | 'llm' | 'laya' | 'prefilter';
  questionSetSha: string;
  articleRevision: string;
  stateSha256: string;
  cardInputSha256: string;
}

/** The stored answers of `cardIds` (the user's cards and labels) for the articles. */
export async function loadRankAnswers(
  db: Executor,
  input: { articleIds: readonly string[]; cardIds: readonly string[] },
): Promise<RankAnswerRow[]> {
  if (input.articleIds.length === 0 || input.cardIds.length === 0) return [];
  const result = await db.execute<{
    article_id: string;
    card_id: string;
    p: number;
    engine: RankAnswerRow['engine'];
    question_set_sha: string;
    article_revision: string;
    state_sha256: string;
    card_input_sha256: string;
  }>(sql`
    SELECT article_id::text AS article_id, card_id::text AS card_id, p, engine, question_set_sha,
           article_revision::text AS article_revision, state_sha256, card_input_sha256
      FROM card_answers
     WHERE article_id = ANY(${sql.param([...input.articleIds])}::bigint[])
       AND card_id = ANY(${sql.param([...input.cardIds])}::bigint[])`);
  return result.rows.map((row) => ({
    articleId: row.article_id,
    cardId: row.card_id,
    p: row.p,
    engine: row.engine,
    questionSetSha: row.question_set_sha,
    articleRevision: row.article_revision,
    stateSha256: row.state_sha256,
    cardInputSha256: row.card_input_sha256,
  }));
}

/** A `match_queue` row of one of the user's cards at the article's current revision. */
export interface RankQueueRow {
  articleId: string;
  cardId: string;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: Date;
}

export async function loadRankQueueRows(
  db: Executor,
  input: { articleIds: readonly string[]; cardIds: readonly string[] },
): Promise<RankQueueRow[]> {
  if (input.articleIds.length === 0 || input.cardIds.length === 0) return [];
  const result = await db.execute<{
    article_id: string;
    card_id: string;
    attempts: number;
    last_error: string | null;
    next_attempt_at: RawTimestamp;
  }>(sql`
    SELECT q.article_id::text AS article_id, q.card_id::text AS card_id, q.attempts, q.last_error,
           q.next_attempt_at
      FROM match_queue q
      JOIN articles a ON a.id = q.article_id AND a.content_revision = q.article_revision
     WHERE q.article_id = ANY(${sql.param([...input.articleIds])}::bigint[])
       AND q.card_id = ANY(${sql.param([...input.cardIds])}::bigint[])`);
  return result.rows.map((row) => ({
    articleId: row.article_id,
    cardId: row.card_id,
    attempts: row.attempts,
    lastError: row.last_error,
    nextAttemptAt: toDate(row.next_attempt_at),
  }));
}

/** The stored ranking and label state of the user's rows (spec 06 §7 step 5 compares with it). */
export interface StoredRankRow {
  articleId: string;
  lane: string;
  tier: number | null;
  pLike: number | null;
  scoreSource: string;
  rulesFired: string[];
  explain: unknown;
  labelSuggestions: string[];
  labelIds: string[];
  scoreVersion: string;
  rankRevision: string;
  nextRankAt: Date | null;
  scoredAt: Date | null;
}

export async function loadStoredRanks(
  db: Executor,
  input: { userId: string; articleIds: readonly string[] },
): Promise<Map<string, StoredRankRow>> {
  if (input.articleIds.length === 0) return new Map();
  const result = await db.execute<{
    article_id: string;
    lane: string;
    tier: number | null;
    p_like: number | null;
    score_source: string;
    rules_fired: string[];
    explain: unknown;
    label_suggestions: string[];
    label_ids: string[];
    score_version: string;
    rank_revision: string;
    next_rank_at: RawTimestamp | null;
    scored_at: RawTimestamp | null;
  }>(sql`
    SELECT article_id::text AS article_id, lane, tier, p_like, score_source, rules_fired, explain,
           label_suggestions::text[] AS label_suggestions, label_ids::text[] AS label_ids,
           score_version, rank_revision::text AS rank_revision, next_rank_at, scored_at
      FROM user_article
     WHERE user_id = ${input.userId}::uuid
       AND article_id = ANY(${sql.param([...input.articleIds])}::bigint[])`);
  return new Map(
    result.rows.map((row) => [
      row.article_id,
      {
        articleId: row.article_id,
        lane: row.lane,
        tier: row.tier,
        pLike: row.p_like,
        scoreSource: row.score_source,
        rulesFired: row.rules_fired,
        explain: row.explain,
        labelSuggestions: row.label_suggestions,
        labelIds: row.label_ids,
        scoreVersion: row.score_version,
        rankRevision: row.rank_revision,
        nextRankAt: toDateOrNull(row.next_rank_at),
        scoredAt: toDateOrNull(row.scored_at),
      },
    ]),
  );
}

/** The English translation rows of the articles at their current revision (spec 07 §3). */
export async function loadRankTranslations(
  db: Executor,
  articleIds: readonly string[],
): Promise<
  Array<{
    articleId: string;
    articleRevision: string;
    sourceSha256: string;
    engine: 'libretranslate' | 'ollama';
    model: string | null;
    sourceLang: string;
    title: string | null;
    excerpt: string | null;
    bodyLead: string | null;
    quality: 'ok' | 'weak' | 'fail';
    qualityDetail: Record<string, unknown>;
    createdAt: Date;
  }>
> {
  if (articleIds.length === 0) return [];
  const result = await db.execute<{
    article_id: string;
    article_revision: string;
    source_sha256: string;
    engine: 'libretranslate' | 'ollama';
    model: string | null;
    source_lang: string;
    title: string | null;
    excerpt: string | null;
    body_lead: string | null;
    quality: 'ok' | 'weak' | 'fail';
    quality_detail: Record<string, unknown>;
    created_at: RawTimestamp;
  }>(sql`
    SELECT t.article_id::text AS article_id, t.article_revision::text AS article_revision,
           t.source_sha256, t.engine, t.model, t.source_lang, t.title, t.excerpt, t.body_lead,
           t.quality, t.quality_detail, t.created_at
      FROM article_translations t
      JOIN articles a ON a.id = t.article_id AND a.content_revision = t.article_revision
     WHERE t.article_id = ANY(${sql.param([...articleIds])}::bigint[]) AND t.target_lang = 'en'
     ORDER BY t.article_id, t.engine`);
  return result.rows.map((row) => ({
    articleId: row.article_id,
    articleRevision: row.article_revision,
    sourceSha256: row.source_sha256,
    engine: row.engine,
    model: row.model,
    sourceLang: row.source_lang,
    title: row.title,
    excerpt: row.excerpt,
    bodyLead: row.body_lead,
    quality: row.quality,
    qualityDetail: row.quality_detail,
    createdAt: toDate(row.created_at),
  }));
}
