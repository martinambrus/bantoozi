import { sql } from 'drizzle-orm';

import type { Executor } from '../client.js';
import { toDate, toDateOrNull, type RawTimestamp } from '../timestamps.js';

/**
 * What the model-state builders read about an article (spec 05 §3.1, §6): shared publisher metadata
 * only, never a subscriber's feed-title override, folder, identity or rating.
 */
export interface ClassificationArticle {
  id: string;
  /** `content_revision`, the fencing token of every classification result (spec 02 §3.3). */
  revision: string;
  pipelineState: string;
  title: string;
  titleNorm: string;
  author: string | null;
  categories: string[];
  excerpt: string | null;
  lang: string | null;
  wordCount: number | null;
  firstSeenAt: Date;
  publishedAt: Date | null;
  storyClusterId: string | null;
  clusterSetId: string | null;
  enrichEngine: string | null;
  /** `article_bodies.body_lead` of the body stored at the current revision, else null. */
  bodyLead: string | null;
  /**
   * The canonical feed: the carrier with the oldest `feed_items.first_seen_at`, then the lowest
   * feed id (spec 05 §3.1). Null for an article no feed carries any more.
   */
  feed: CanonicalFeed | null;
}

export interface CanonicalFeed {
  id: string;
  title: string | null;
  siteUrl: string | null;
  url: string;
  /** `feeds.fetch_options` (spec 07 §3 reads `translate_strong`). */
  fetchOptions: Record<string, unknown>;
}

type ArticleInputRow = {
  id: string;
  revision: string;
  pipeline_state: string;
  title: string;
  title_norm: string;
  author: string | null;
  categories: string[];
  excerpt: string | null;
  lang: string | null;
  word_count: number | null;
  first_seen_at: RawTimestamp;
  published_at: RawTimestamp | null;
  story_cluster_id: string | null;
  cluster_set_id: string | null;
  enrich_engine: string | null;
  body_lead: string | null;
  feed_id: string | null;
  feed_title: string | null;
  feed_site_url: string | null;
  feed_url: string | null;
  feed_fetch_options: Record<string, unknown> | null;
};

function toArticle(row: ArticleInputRow): ClassificationArticle {
  return {
    id: row.id,
    revision: row.revision,
    pipelineState: row.pipeline_state,
    title: row.title,
    titleNorm: row.title_norm,
    author: row.author,
    categories: row.categories,
    excerpt: row.excerpt,
    lang: row.lang,
    wordCount: row.word_count,
    firstSeenAt: toDate(row.first_seen_at),
    publishedAt: toDateOrNull(row.published_at),
    storyClusterId: row.story_cluster_id,
    clusterSetId: row.cluster_set_id,
    enrichEngine: row.enrich_engine,
    bodyLead: row.body_lead,
    feed:
      row.feed_id === null || row.feed_url === null
        ? null
        : {
            id: row.feed_id,
            title: row.feed_title,
            siteUrl: row.feed_site_url,
            url: row.feed_url,
            fetchOptions: row.feed_fetch_options ?? {},
          },
  };
}

const selectArticles = (ids: readonly string[]) => sql`
  SELECT a.id::text AS id, a.content_revision::text AS revision, a.pipeline_state, a.title,
         a.title_norm, a.author, a.categories, a.excerpt, a.lang, a.word_count, a.first_seen_at,
         a.published_at, a.story_cluster_id::text AS story_cluster_id,
         a.cluster_set_id::text AS cluster_set_id, a.enrich_engine,
         b.body_lead, f.id::text AS feed_id, f.title AS feed_title, f.site_url AS feed_site_url,
         f.url AS feed_url, f.fetch_options AS feed_fetch_options
    FROM articles a
    LEFT JOIN article_bodies b ON b.article_id = a.id AND b.article_revision = a.content_revision
    LEFT JOIN LATERAL (SELECT fi.feed_id FROM feed_items fi WHERE fi.article_id = a.id
                        ORDER BY fi.first_seen_at, fi.feed_id LIMIT 1) cf ON true
    LEFT JOIN feeds f ON f.id = cf.feed_id
   WHERE a.id = ANY(${sql.param([...ids])}::bigint[])`;

/** The article's classification inputs at its current revision, or null when it is gone. */
export async function loadClassificationArticle(
  db: Executor,
  articleId: string,
): Promise<ClassificationArticle | null> {
  const result = await db.execute<ArticleInputRow>(selectArticles([articleId]));
  const row = result.rows[0];
  return row === undefined ? null : toArticle(row);
}

/** Batch form for backfill pages: missing articles are simply absent from the map. */
export async function loadClassificationArticles(
  db: Executor,
  articleIds: readonly string[],
): Promise<Map<string, ClassificationArticle>> {
  if (articleIds.length === 0) return new Map();
  const result = await db.execute<ArticleInputRow>(selectArticles(articleIds));
  return new Map(result.rows.map((row) => [row.id, toArticle(row)]));
}

/**
 * Lock the article row for a guarded completion (spec 02 §3.3) and return its current revision and
 * pipeline state; null when it is gone. `share` suffices for writers that only need the revision to
 * stay put; `update` for writers that change the row itself.
 */
export async function lockArticleRevision(
  db: Executor,
  articleId: string,
  mode: 'share' | 'update',
): Promise<{ revision: string; pipelineState: string; storyClusterId: string | null } | null> {
  const lock = mode === 'update' ? sql`FOR UPDATE` : sql`FOR SHARE`;
  const result = await db.execute<{
    revision: string;
    pipeline_state: string;
    story_cluster_id: string | null;
  }>(sql`
    SELECT content_revision::text AS revision, pipeline_state,
           story_cluster_id::text AS story_cluster_id
      FROM articles WHERE id = ${articleId}::bigint ${lock}`);
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        revision: row.revision,
        pipelineState: row.pipeline_state,
        storyClusterId: row.story_cluster_id,
      };
}
