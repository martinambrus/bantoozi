import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { users } from './accounts.js';
import { articles, feeds } from './articles.js';
import { int8, tstz } from './columns.js';

// Spec 02 §3.1: model answers (versioned caches and immutable call audit).

export const questionSets = pgTable(
  'question_sets',
  {
    id: int8('id').primaryKey().generatedAlwaysAsIdentity(),
    kind: text('kind').notNull(),
    version: text('version').notNull().unique(),
    sha256: text('sha256').notNull().unique(),
    definition: jsonb('definition').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  () => [check('question_sets_kind_check', sql`kind IN ('enrich','match','cluster','suggest')`)],
);

export const engineReservations = pgTable(
  'engine_reservations',
  {
    id: uuid('id').primaryKey(),
    day: date('day', { mode: 'string' }).notNull(),
    engine: text('engine').notNull(),
    kind: text('kind').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    reservedUsd: numeric('reserved_usd', { precision: 14, scale: 8 }).notNull(),
    reservedCalls: integer('reserved_calls').notNull().default(1),
    status: text('status').notNull(),
    actualUsd: numeric('actual_usd', { precision: 14, scale: 8 }),
    createdAt: tstz('created_at').notNull().defaultNow(),
    settledAt: tstz('settled_at'),
    expiresAt: tstz('expires_at').notNull(),
  },
  (t) => [
    check('engine_reservations_reserved_usd_check', sql`reserved_usd >= 0`),
    check('engine_reservations_reserved_calls_check', sql`reserved_calls > 0`),
    check('engine_reservations_status_check', sql`status IN ('reserved','settled','uncertain')`),
    check('engine_reservations_actual_usd_check', sql`actual_usd >= 0`),
    check(
      'engine_reservations_settled_check',
      sql`(status = 'settled') = (settled_at IS NOT NULL)`,
    ),
    index('engine_reservations_day_idx').on(t.day, t.status),
  ],
);

export const engineCalls = pgTable(
  'engine_calls',
  {
    id: int8('id').primaryKey().generatedAlwaysAsIdentity(),
    engine: text('engine').notNull(),
    kind: text('kind').notNull(),
    model: text('model'),
    articleId: int8('article_id').references(() => articles.id, { onDelete: 'set null' }),
    questionSetId: int8('question_set_id').references(() => questionSets.id, {
      onDelete: 'restrict',
    }),
    reservationId: uuid('reservation_id')
      .unique()
      .references(() => engineReservations.id, { onDelete: 'set null' }),
    logicalRequestId: uuid('logical_request_id').notNull(),
    credentialVersion: int8('credential_version'),
    articleRevision: int8('article_revision'),
    stateSha256: text('state_sha256'),
    cardIds: int8('card_ids').array(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    nQuestions: integer('n_questions').notNull().default(0),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 12, scale: 8 })
      .notNull()
      .default(sql`0`),
    billing: text('billing').notNull().default('known'),
    latencyMs: integer('latency_ms'),
    attempts: integer('attempts').notNull().default(1),
    status: text('status').notNull(),
    error: text('error'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('engine_calls_engine_check', sql`engine IN ('typesafe','llm','laya','libretranslate')`),
    check(
      'engine_calls_kind_check',
      sql`kind IN ('enrich','match','cluster','suggest','translate','credential_probe','eval')`,
    ),
    check('engine_calls_credential_version_check', sql`credential_version > 0`),
    check('engine_calls_article_revision_check', sql`article_revision > 0`),
    check('engine_calls_n_questions_check', sql`n_questions >= 0`),
    check('engine_calls_input_tokens_check', sql`input_tokens >= 0`),
    check('engine_calls_output_tokens_check', sql`output_tokens >= 0`),
    check('engine_calls_cost_usd_check', sql`cost_usd >= 0`),
    check('engine_calls_billing_check', sql`billing IN ('known','uncertain')`),
    check('engine_calls_latency_ms_check', sql`latency_ms >= 0`),
    check('engine_calls_attempts_check', sql`attempts > 0`),
    check(
      'engine_calls_status_check',
      sql`status IN ('ok','error','timeout','rate_limited','invalid_request','invalid_response','auth_error')`,
    ),
    index('engine_calls_created_idx').on(t.createdAt),
    index('engine_calls_article_idx').on(t.articleId),
    uniqueIndex('engine_calls_attempt_idx').on(t.logicalRequestId, t.engine, t.attempts),
  ],
);

export const articleFacets = pgTable(
  'article_facets',
  {
    articleId: int8('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    questionSetId: int8('question_set_id')
      .notNull()
      .references(() => questionSets.id, { onDelete: 'restrict' }),
    articleRevision: int8('article_revision').notNull(),
    stateSha256: text('state_sha256').notNull(),
    engine: text('engine').notNull(),
    model: text('model'),
    stateVariant: text('state_variant').notNull(),
    answers: jsonb('answers').notNull(),
    features: jsonb('features').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'article_facets_pkey', columns: [t.articleId, t.questionSetId] }),
    check('article_facets_article_revision_check', sql`article_revision > 0`),
    check('article_facets_state_variant_check', sql`state_variant IN ('native','translated')`),
  ],
);

export const topics = pgTable(
  'topics',
  {
    id: text('id').primaryKey(),
    parentId: text('parent_id').references((): AnyPgColumn => topics.id, { onDelete: 'restrict' }),
    level: smallint('level').notNull(),
    nameEn: text('name_en').notNull(),
    nameSk: text('name_sk').notNull(),
    description: text('description').notNull(),
    sort: integer('sort').notNull().default(0),
  },
  () => [
    check('topics_level_check', sql`level IN (1,2)`),
    check(
      'topics_level_parent_check',
      sql`(level = 1 AND parent_id IS NULL) OR (level = 2 AND parent_id IS NOT NULL)`,
    ),
    check('topics_parent_not_self_check', sql`parent_id IS NULL OR parent_id <> id`),
  ],
);

export const interestCards = pgTable(
  'interest_cards',
  {
    id: int8('id').primaryKey().generatedAlwaysAsIdentity(),
    kind: text('kind').notNull(),
    slug: text('slug').unique(),
    title: text('title').notNull(),
    body: jsonb('body').notNull(),
    textHash: text('text_hash').notNull().unique(),
    lang: text('lang').notNull().default('en'),
    topicIds: text('topic_ids')
      .array()
      .notNull()
      .default(sql`'{}'`),
    origin: text('origin').notNull(),
    visibility: text('visibility').notNull(),
    parentCardId: int8('parent_card_id').references((): AnyPgColumn => interestCards.id, {
      onDelete: 'set null',
    }),
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
    creatorUserId: uuid('creator_user_id').references(() => users.id, { onDelete: 'set null' }),
    publicationVetoAt: tstz('publication_veto_at'),
    i18n: jsonb('i18n')
      .notNull()
      .default(sql`'{}'`),
    createdAt: tstz('created_at').notNull().defaultNow(),
    retiredAt: tstz('retired_at'),
  },
  (t) => [
    check('interest_cards_kind_check', sql`kind IN ('interest','label')`),
    check('interest_cards_origin_check', sql`origin IN ('library','user','fork')`),
    check('interest_cards_visibility_check', sql`visibility IN ('public','shared','private')`),
    check(
      'interest_cards_private_owner_check',
      sql`(visibility = 'private') = (owner_user_id IS NOT NULL)`,
    ),
    index('interest_cards_topics_idx').using('gin', t.topicIds),
  ],
);

export const libraryCardVersions = pgTable(
  'library_card_versions',
  {
    librarySlug: text('library_slug').notNull(),
    version: integer('version').notNull(),
    cardId: int8('card_id')
      .notNull()
      .unique()
      .references(() => interestCards.id, { onDelete: 'restrict' }),
    previousCardId: int8('previous_card_id').references(() => interestCards.id, {
      onDelete: 'restrict',
    }),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'library_card_versions_pkey', columns: [t.librarySlug, t.version] }),
    check('library_card_versions_version_check', sql`version > 0`),
    check(
      'library_card_versions_previous_check',
      sql`previous_card_id IS NULL OR previous_card_id <> card_id`,
    ),
  ],
);

export const cardAnswers = pgTable(
  'card_answers',
  {
    articleId: int8('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    cardId: int8('card_id')
      .notNull()
      .references(() => interestCards.id, { onDelete: 'cascade' }),
    p: real('p').notNull(),
    engine: text('engine').notNull(),
    model: text('model'),
    questionSetSha: text('question_set_sha')
      .notNull()
      .references(() => questionSets.sha256, { onDelete: 'restrict' }),
    articleRevision: int8('article_revision').notNull(),
    stateSha256: text('state_sha256').notNull(),
    cardInputSha256: text('card_input_sha256').notNull(),
    stateVariant: text('state_variant').notNull(),
    answeredAt: tstz('answered_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'card_answers_pkey', columns: [t.articleId, t.cardId] }),
    check('card_answers_p_check', sql`p >= 0 AND p <= 1`),
    check('card_answers_engine_check', sql`engine IN ('typesafe','llm','laya','prefilter')`),
    check('card_answers_article_revision_check', sql`article_revision > 0`),
    check('card_answers_state_variant_check', sql`state_variant IN ('native','translated')`),
    index('card_answers_card_idx').on(t.cardId),
  ],
);

export const articleTopicsL2 = pgTable(
  'article_topics_l2',
  {
    articleId: int8('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    l1Id: text('l1_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'restrict' }),
    articleRevision: int8('article_revision').notNull(),
    questionSetSha: text('question_set_sha')
      .notNull()
      .references(() => questionSets.sha256, { onDelete: 'restrict' }),
    stateSha256: text('state_sha256').notNull(),
    engine: text('engine').notNull(),
    model: text('model'),
    stateVariant: text('state_variant').notNull(),
    answer: jsonb('answer').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'article_topics_l2_pkey', columns: [t.articleId, t.l1Id] }),
    check('article_topics_l2_article_revision_check', sql`article_revision > 0`),
    check('article_topics_l2_state_variant_check', sql`state_variant IN ('native','translated')`),
  ],
);

export const matchQueue = pgTable(
  'match_queue',
  {
    articleId: int8('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    cardId: int8('card_id')
      .notNull()
      .references(() => interestCards.id, { onDelete: 'cascade' }),
    articleRevision: int8('article_revision').notNull(),
    leaseToken: uuid('lease_token'),
    leaseUntil: tstz('lease_until'),
    nextAttemptAt: tstz('next_attempt_at').notNull().defaultNow(),
    lastError: text('last_error'),
    priority: smallint('priority').notNull().default(5),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    attempts: smallint('attempts').notNull().default(0),
    enqueuedAt: tstz('enqueued_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'match_queue_pkey', columns: [t.articleId, t.cardId] }),
    check('match_queue_article_revision_check', sql`article_revision > 0`),
    check('match_queue_priority_check', sql`priority BETWEEN 1 AND 9`),
    check('match_queue_attempts_check', sql`attempts >= 0`),
    check('match_queue_lease_check', sql`(lease_token IS NULL) = (lease_until IS NULL)`),
    index('match_queue_order_idx').on(t.priority, t.enqueuedAt),
  ],
);

export const feedCards = pgTable(
  'feed_cards',
  {
    feedId: int8('feed_id')
      .notNull()
      .references(() => feeds.id, { onDelete: 'cascade' }),
    cardId: int8('card_id')
      .notNull()
      .references(() => interestCards.id, { onDelete: 'cascade' }),
    holders: integer('holders').notNull(),
  },
  (t) => [
    primaryKey({ name: 'feed_cards_pkey', columns: [t.feedId, t.cardId] }),
    check('feed_cards_holders_check', sql`holders > 0`),
  ],
);

/** Cost attribution rollup; the all-zero UUID is the platform sentinel (no user FK). */
export const usageDaily = pgTable(
  'usage_daily',
  {
    day: date('day', { mode: 'string' }).notNull(),
    userId: uuid('user_id').notNull(),
    engine: text('engine').notNull(),
    kind: text('kind').notNull(),
    calls: integer('calls').notNull().default(0),
    inputTokens: int8('input_tokens')
      .notNull()
      .default(sql`0`),
    outputTokens: int8('output_tokens')
      .notNull()
      .default(sql`0`),
    costUsd: numeric('cost_usd', { precision: 14, scale: 8 })
      .notNull()
      .default(sql`0`),
  },
  (t) => [
    primaryKey({ name: 'usage_daily_pkey', columns: [t.day, t.userId, t.engine, t.kind] }),
    check('usage_daily_calls_check', sql`calls >= 0`),
    check('usage_daily_input_tokens_check', sql`input_tokens >= 0`),
    check('usage_daily_output_tokens_check', sql`output_tokens >= 0`),
    check('usage_daily_cost_usd_check', sql`cost_usd >= 0`),
  ],
);
