import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  unique,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { int8, tstz } from './columns.js';
import { questionSets } from './models.js';

// Spec 02 §3: the shared article layer.

export const originFetchState = pgTable(
  'origin_fetch_state',
  {
    origin: text('origin').primaryKey(),
    nextStartAt: tstz('next_start_at').notNull().defaultNow(),
    blockedUntil: tstz('blocked_until'),
    leases: jsonb('leases')
      .notNull()
      .default(sql`'[]'`),
    lastUsedAt: tstz('last_used_at').notNull().defaultNow(),
  },
  () => [
    check(
      'origin_fetch_state_leases_check',
      sql`jsonb_typeof(leases) = 'array' AND jsonb_array_length(leases) <= 2`,
    ),
  ],
);

export const feeds = pgTable(
  'feeds',
  {
    id: int8('id').primaryKey().generatedAlwaysAsIdentity(),
    url: text('url').notNull().unique(),
    fetchUrl: text('fetch_url').notNull(),
    mergedIntoId: int8('merged_into_id').references((): AnyPgColumn => feeds.id, {
      onDelete: 'restrict',
    }),
    siteUrl: text('site_url'),
    title: text('title'),
    description: text('description'),
    iconUrl: text('icon_url'),
    langHint: text('lang_hint'),
    status: text('status').notNull().default('active'),
    etag: text('etag'),
    lastModified: text('last_modified'),
    fetchIntervalS: integer('fetch_interval_s').notNull().default(900),
    minIntervalS: integer('min_interval_s').notNull().default(900),
    nextFetchAt: tstz('next_fetch_at').notNull().defaultNow(),
    lastFetchAt: tstz('last_fetch_at'),
    lastSuccessAt: tstz('last_success_at'),
    lastNewItemAt: tstz('last_new_item_at'),
    consecutiveErrors: integer('consecutive_errors').notNull().default(0),
    consecutiveEmpty: integer('consecutive_empty').notNull().default(0),
    quarantineCount: integer('quarantine_count').notNull().default(0),
    totalFetches: integer('total_fetches').notNull().default(0),
    totalErrors: integer('total_errors').notNull().default(0),
    totalEmpty: integer('total_empty').notNull().default(0),
    lastErrorCode: text('last_error_code'),
    lastError: text('last_error'),
    lastErrorAt: tstz('last_error_at'),
    firstErrorAt: tstz('first_error_at'),
    quarantinedUntil: tstz('quarantined_until'),
    subscriberCount: integer('subscriber_count').notNull().default(0),
    unsubscribedAt: tstz('unsubscribed_at').defaultNow(),
    publishStats: jsonb('publish_stats')
      .notNull()
      .default(sql`'{}'`),
    fetchOptions: jsonb('fetch_options')
      .notNull()
      .default(sql`'{}'`),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('feeds_status_check', sql`status IN ('active','quarantined','dead','paused')`),
    check('feeds_fetch_interval_s_check', sql`fetch_interval_s > 0`),
    check('feeds_min_interval_s_check', sql`min_interval_s > 0`),
    check('feeds_subscriber_count_check', sql`subscriber_count >= 0`),
    check(
      'feeds_merged_check',
      sql`merged_into_id IS NULL OR (merged_into_id <> id AND status = 'dead')`,
    ),
    index('feeds_due_idx')
      .on(t.nextFetchAt)
      .where(sql`subscriber_count > 0 AND status IN ('active','quarantined')`),
  ],
);

export const storyClusters = pgTable(
  'story_clusters',
  {
    id: int8('id').primaryKey().generatedAlwaysAsIdentity(),
    representativeArticleId: int8('representative_article_id'),
    size: integer('size').notNull().default(1),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('story_clusters_size_check', sql`size >= 0`),
    foreignKey({
      name: 'story_clusters_rep_fk',
      columns: [t.representativeArticleId],
      foreignColumns: [articles.id],
    }).onDelete('set null'),
  ],
);

export const articles = pgTable(
  'articles',
  {
    id: int8('id').primaryKey().generatedAlwaysAsIdentity(),
    url: text('url'),
    canonicalUrl: text('canonical_url').notNull(),
    urlKey: text('url_key').notNull().unique(),
    title: text('title').notNull(),
    titleNorm: text('title_norm').notNull(),
    author: text('author'),
    categories: text('categories')
      .array()
      .notNull()
      .default(sql`'{}'`),
    excerpt: text('excerpt'),
    excerptHtml: text('excerpt_html'),
    imageUrl: text('image_url'),
    publishedAt: tstz('published_at'),
    firstSeenAt: tstz('first_seen_at').notNull().defaultNow(),
    lang: text('lang'),
    langConfidence: real('lang_confidence'),
    wordCount: integer('word_count'),
    // Media signals (spec 03 §6.4, R2; migration 0010 appends them after `updated_at`): null is
    // unknown; `has_video` never goes from true back to false; `body_image_count` describes the
    // stored body, like `word_count`; `media_revision` counts their changes.
    hasVideo: boolean('has_video'),
    bodyImageCount: integer('body_image_count'),
    mediaRevision: int8('media_revision')
      .notNull()
      .default(sql`0`),
    contentHash: text('content_hash').notNull(),
    contentRevision: int8('content_revision')
      .notNull()
      .default(sql`1`),
    storyClusterId: int8('story_cluster_id').references((): AnyPgColumn => storyClusters.id, {
      onDelete: 'set null',
    }),
    clusterSetId: int8('cluster_set_id'),
    pipelineState: text('pipeline_state').notNull().default('ingested'),
    enrichEngine: text('enrich_engine'),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('articles_lang_confidence_check', sql`lang_confidence BETWEEN 0 AND 1`),
    check('articles_word_count_check', sql`word_count >= 0`),
    check('articles_body_image_count_check', sql`body_image_count >= 0`),
    check('articles_media_revision_check', sql`media_revision >= 0`),
    check('articles_content_revision_check', sql`content_revision > 0`),
    check(
      'articles_pipeline_state_check',
      sql`pipeline_state IN ('ingested','stale','extracted','translated','enriched','matched','degraded','failed')`,
    ),
    foreignKey({
      name: 'articles_cluster_set_fk',
      columns: [t.clusterSetId],
      foreignColumns: [questionSets.id],
    }).onDelete('restrict'),
    index('articles_first_seen_idx').on(t.firstSeenAt.desc().nullsFirst()),
    index('articles_title_trgm_idx').using('gin', t.titleNorm.op('gin_trgm_ops')),
    index('articles_cluster_idx')
      .on(t.storyClusterId)
      .where(sql`story_cluster_id IS NOT NULL`),
    index('articles_state_idx').on(t.pipelineState, t.firstSeenAt),
  ],
);

export const feedItems = pgTable(
  'feed_items',
  {
    feedId: int8('feed_id')
      .notNull()
      .references(() => feeds.id, { onDelete: 'cascade' }),
    articleId: int8('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    guid: text('guid'),
    firstSeenAt: tstz('first_seen_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'feed_items_pkey', columns: [t.feedId, t.articleId] }),
    index('feed_items_article_idx').on(t.articleId),
    index('feed_items_feed_time_idx').on(t.feedId, t.firstSeenAt.desc().nullsFirst()),
    // md5(guid): long GUIDs (≤ 4,096 chars) exceed a B-tree key (D-15, migration 0009).
    uniqueIndex('feed_items_guid_idx')
      .on(t.feedId, sql`md5(guid)`)
      .where(sql`guid IS NOT NULL`),
  ],
);

export const articleAliases = pgTable(
  'article_aliases',
  {
    urlKey: text('url_key').primaryKey(),
    articleId: int8('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
  },
  () => [
    check(
      'article_aliases_source_check',
      sql`source IN ('feed_link','redirect','rel_canonical','near_duplicate')`,
    ),
  ],
);

export const articleBodies = pgTable(
  'article_bodies',
  {
    articleId: int8('article_id')
      .primaryKey()
      .references(() => articles.id, { onDelete: 'cascade' }),
    articleRevision: int8('article_revision').notNull(),
    resolvedUrl: text('resolved_url'),
    status: text('status').notNull(),
    httpStatus: integer('http_status'),
    bodyText: text('body_text'),
    bodyHtml: text('body_html'),
    completeness: text('completeness').notNull().default('partial'),
    completenessReason: text('completeness_reason'),
    bodyLead: text('body_lead'),
    extractorVersion: text('extractor_version').notNull(),
    error: text('error'),
    extractedAt: tstz('extracted_at').notNull().defaultNow(),
  },
  () => [
    check('article_bodies_article_revision_check', sql`article_revision > 0`),
    check(
      'article_bodies_status_check',
      sql`status IN ('ok','skipped','failed','blocked','too_large','not_html')`,
    ),
    check('article_bodies_completeness_check', sql`completeness IN ('complete','partial')`),
    check(
      'article_bodies_size_check',
      sql`coalesce(octet_length(body_text), 0) + coalesce(octet_length(body_html), 0) <= 10485760`,
    ),
  ],
);

/** Immutable bookmark archive (STORAGE/COMPRESSION are set in the hand-written migration). */
export const articleSnapshots = pgTable(
  'article_snapshots',
  {
    id: int8('id').primaryKey().generatedAlwaysAsIdentity(),
    articleId: int8('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'restrict' }),
    sourceRevision: int8('source_revision').notNull(),
    capturedAt: tstz('captured_at').notNull().defaultNow(),
    sourceUrl: text('source_url'),
    title: text('title').notNull(),
    author: text('author'),
    publishedAt: tstz('published_at'),
    bodyText: text('body_text').notNull().default(''),
    bodyHtml: text('body_html'),
    contentSha256: text('content_sha256').notNull(),
    completeness: text('completeness').notNull(),
    completenessReason: text('completeness_reason'),
    source: text('source').notNull(),
    extractorVersion: text('extractor_version').notNull(),
    coldAt: tstz('cold_at'),
    unreferencedAt: tstz('unreferenced_at'),
  },
  (t) => [
    check('article_snapshots_source_revision_check', sql`source_revision > 0`),
    check('article_snapshots_completeness_check', sql`completeness IN ('complete','partial')`),
    check('article_snapshots_source_check', sql`source IN ('feed','page')`),
    check(
      'article_snapshots_size_check',
      sql`coalesce(octet_length(body_text), 0) + coalesce(octet_length(body_html), 0) <= 10485760`,
    ),
    unique('article_snapshots_identity_key').on(t.articleId, t.sourceRevision, t.contentSha256),
  ],
);

export const articleTranslations = pgTable(
  'article_translations',
  {
    articleId: int8('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    articleRevision: int8('article_revision').notNull(),
    sourceSha256: text('source_sha256').notNull(),
    targetLang: text('target_lang').notNull().default('en'),
    engine: text('engine').notNull(),
    model: text('model'),
    sourceLang: text('source_lang').notNull(),
    title: text('title'),
    excerpt: text('excerpt'),
    bodyLead: text('body_lead'),
    quality: text('quality').notNull(),
    qualityDetail: jsonb('quality_detail')
      .notNull()
      .default(sql`'{}'`),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: 'article_translations_pkey',
      columns: [t.articleId, t.targetLang, t.engine],
    }),
    check('article_translations_article_revision_check', sql`article_revision > 0`),
    check('article_translations_engine_check', sql`engine IN ('libretranslate','ollama')`),
    check('article_translations_quality_check', sql`quality IN ('ok','weak','fail')`),
  ],
);
