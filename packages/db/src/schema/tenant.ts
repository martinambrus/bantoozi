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
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './accounts.js';
import { articles, articleSnapshots, feeds } from './articles.js';
import { int8, tstz } from './columns.js';
import { interestCards, questionSets } from './models.js';

// Spec 02 §4: per-user tables. Every table has RLS (spec 02 §5, hand-written migration).
// user_cards.card_id and user_labels.card_id reference interest_cards through
// DEFERRABLE INITIALLY DEFERRED foreign keys, which Drizzle cannot express; the hand-written
// migration adds them.

export const subscriptions = pgTable(
  'subscriptions',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    feedId: int8('feed_id')
      .notNull()
      .references(() => feeds.id, { onDelete: 'cascade' }),
    titleOverride: text('title_override'),
    folder: text('folder'),
    allowDuplicates: boolean('allow_duplicates').notNull().default(false),
    hidden: boolean('hidden').notNull().default(false),
    inferenceMode: text('inference_mode').notNull().default('off'),
    inferenceVersion: int8('inference_version')
      .notNull()
      .default(sql`0`),
    inferenceActivatedAt: tstz('inference_activated_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'subscriptions_pkey', columns: [t.userId, t.feedId] }),
    check('subscriptions_inference_mode_check', sql`inference_mode IN ('off','training','active')`),
    check('subscriptions_inference_version_check', sql`inference_version >= 0`),
    check(
      'subscriptions_activation_check',
      sql`(inference_mode = 'active') = (inference_activated_at IS NOT NULL)`,
    ),
    index('subscriptions_feed_idx').on(t.feedId),
  ],
);

export const userFeedPreferences = pgTable(
  'user_feed_preferences',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    feedId: int8('feed_id')
      .notNull()
      .references(() => feeds.id, { onDelete: 'restrict' }),
    imagePolicy: text('image_policy').notNull().default('inherit'),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'user_feed_preferences_pkey', columns: [t.userId, t.feedId] }),
    check(
      'user_feed_preferences_image_policy_check',
      sql`image_policy IN ('inherit','allow','block')`,
    ),
  ],
);

export const analysisRequests = pgTable(
  'analysis_requests',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    feedId: int8('feed_id')
      .notNull()
      .references(() => feeds.id, { onDelete: 'restrict' }),
    articleId: int8('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    articleRevision: int8('article_revision').notNull(),
    inferenceVersion: int8('inference_version').notNull(),
    inputSnapshot: jsonb('input_snapshot').notNull(),
    inputSha: text('input_sha').notNull(),
    resultSnapshot: jsonb('result_snapshot'),
    resultSha: text('result_sha'),
    status: text('status').notNull().default('pending'),
    leaseToken: uuid('lease_token'),
    leaseUntil: tstz('lease_until'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: tstz('next_attempt_at').notNull().defaultNow(),
    lastErrorCode: text('last_error_code'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    completedAt: tstz('completed_at'),
  },
  (t) => [
    check('analysis_requests_article_revision_check', sql`article_revision > 0`),
    check('analysis_requests_inference_version_check', sql`inference_version >= 0`),
    check(
      'analysis_requests_status_check',
      sql`status IN ('pending','running','complete','failed','cancelled')`,
    ),
    check('analysis_requests_attempts_check', sql`attempts >= 0`),
    check('analysis_requests_result_pair', sql`(result_snapshot IS NULL) = (result_sha IS NULL)`),
    check(
      'analysis_requests_complete_result',
      sql`status <> 'complete' OR result_snapshot IS NOT NULL`,
    ),
    check('analysis_requests_lease_pair', sql`(lease_token IS NULL) = (lease_until IS NULL)`),
    check('analysis_requests_running_lease', sql`(status = 'running') = (lease_token IS NOT NULL)`),
    check(
      'analysis_requests_completed_at',
      sql`(status IN ('complete','failed','cancelled')) = (completed_at IS NOT NULL)`,
    ),
    index('analysis_requests_pending_idx')
      .on(t.nextAttemptAt, t.createdAt)
      .where(sql`status IN ('pending','running')`),
    index('analysis_requests_user_article_idx').on(
      t.userId,
      t.articleId,
      t.createdAt.desc().nullsFirst(),
    ),
  ],
);

export const cardPublicationRequests = pgTable(
  'card_publication_requests',
  {
    id: int8('id').primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    cardId: int8('card_id')
      .notNull()
      .references(() => interestCards.id, { onDelete: 'cascade' }),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('pending'),
    cardTextHash: text('card_text_hash').notNull(),
    publicationPayload: jsonb('publication_payload').notNull(),
    publicationSha: text('publication_sha').notNull(),
    version: int8('version')
      .notNull()
      .default(sql`1`),
    requestedAt: tstz('requested_at').notNull().defaultNow(),
    expiresAt: tstz('expires_at'),
    respondedAt: tstz('responded_at'),
    authorizationKind: text('authorization_kind'),
    authorizationEvidence: jsonb('authorization_evidence'),
    promotedAt: tstz('promoted_at'),
    promotedBy: uuid('promoted_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    check(
      'card_publication_requests_status_check',
      sql`status IN ('pending','approved','rejected','expired','promoted')`,
    ),
    check('card_publication_requests_version_check', sql`version > 0`),
    check(
      'card_publication_requests_authorization_kind_check',
      sql`authorization_kind IN ('creator_approval','creator_inactive_30d')`,
    ),
    check('card_publication_requests_expiry', sql`expires_at IS NULL OR expires_at > requested_at`),
    check(
      'card_publication_requests_authorization_pair',
      sql`(authorization_kind IS NULL) = (authorization_evidence IS NULL)`,
    ),
    check(
      'card_publication_requests_promoted_at',
      sql`(status = 'promoted') = (promoted_at IS NOT NULL)`,
    ),
    check(
      'card_publication_requests_promoted_kind',
      sql`(status = 'promoted') = (authorization_kind IS NOT NULL)`,
    ),
    check(
      'card_publication_requests_response',
      sql`status NOT IN ('approved','rejected') OR responded_at IS NOT NULL`,
    ),
    check(
      'card_publication_requests_approval_response',
      sql`authorization_kind <> 'creator_approval' OR responded_at IS NOT NULL`,
    ),
    uniqueIndex('card_publication_pending_idx')
      .on(t.cardId)
      .where(sql`status IN ('pending','approved')`),
  ],
);

export const userCards = pgTable(
  'user_cards',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    cardId: int8('card_id').notNull(),
    strength: text('strength').notNull(),
    scopeFeedId: int8('scope_feed_id'),
    titleOverride: text('title_override'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'user_cards_pkey', columns: [t.userId, t.cardId] }),
    check('user_cards_strength_check', sql`strength IN ('must','love','like','never')`),
    foreignKey({
      name: 'user_cards_scope_fk',
      columns: [t.userId, t.scopeFeedId],
      foreignColumns: [subscriptions.userId, subscriptions.feedId],
    }).onDelete('cascade'),
    index('user_cards_card_idx').on(t.cardId),
  ],
);

export const userLabels = pgTable(
  'user_labels',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    cardId: int8('card_id').notNull(),
    name: text('name').notNull(),
    color: text('color').notNull().default('slate'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: 'user_labels_pkey', columns: [t.userId, t.cardId] })],
);

export const userRules = pgTable(
  'user_rules',
  {
    id: int8('id').primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    value: text('value').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
    expiresAt: tstz('expires_at'),
  },
  (t) => [
    check(
      'user_rules_kind_check',
      sql`kind IN ('mute_keyword','mute_story','block_feed','block_domain','block_author','boost_feed','boost_domain')`,
    ),
    check('user_rules_mute_story_expiry', sql`kind <> 'mute_story' OR expires_at IS NOT NULL`),
    index('user_rules_user_idx').on(t.userId),
  ],
);

export const userArticle = pgTable(
  'user_article',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    articleId: int8('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    // ranking cache (written by user.rank; spec 06)
    lane: text('lane').notNull().default('new'),
    tier: smallint('tier'),
    pLike: real('p_like'),
    scoreSource: text('score_source').notNull().default('none'),
    rulesFired: text('rules_fired')
      .array()
      .notNull()
      .default(sql`'{}'`),
    explain: jsonb('explain'),
    labelSuggestions: int8('label_suggestions')
      .array()
      .notNull()
      .default(sql`'{}'`),
    scoreVersion: text('score_version').notNull().default('0:0'),
    rankRevision: int8('rank_revision')
      .notNull()
      .default(sql`0`),
    nextRankAt: tstz('next_rank_at'),
    scoredAt: tstz('scored_at'),
    // reader state (written by the API)
    stateVersion: int8('state_version')
      .notNull()
      .default(sql`0`),
    openedAt: tstz('opened_at'),
    readAt: tstz('read_at'),
    rating: smallint('rating'),
    reason: text('reason'),
    ratedAt: tstz('rated_at'),
    dwellMs: integer('dwell_ms'),
    bookmarkedAt: tstz('bookmarked_at'),
    bookmarkSnapshotId: int8('bookmark_snapshot_id').references(() => articleSnapshots.id, {
      onDelete: 'restrict',
    }),
    bookmarkOriginFeedId: int8('bookmark_origin_feed_id').references(() => feeds.id, {
      onDelete: 'set null',
    }),
    bookmarkCaptureGeneration: int8('bookmark_capture_generation')
      .notNull()
      .default(sql`0`),
    bookmarkCaptureStatus: text('bookmark_capture_status'),
    bookmarkCaptureErrorCode: text('bookmark_capture_error_code'),
    archivedAt: tstz('archived_at'),
    labelIds: int8('label_ids')
      .array()
      .notNull()
      .default(sql`'{}'`),
    feedbackPromptedAt: tstz('feedback_prompted_at'),
  },
  (t) => [
    primaryKey({ name: 'user_article_pkey', columns: [t.userId, t.articleId] }),
    check('user_article_lane_check', sql`lane IN ('new','for_you','maybe','everything','hidden')`),
    check('user_article_tier_check', sql`tier BETWEEN 1 AND 5`),
    check('user_article_p_like_check', sql`p_like BETWEEN 0 AND 1`),
    check(
      'user_article_score_source_check',
      sql`score_source IN ('none','cards','model','degraded')`,
    ),
    check('user_article_rank_revision_check', sql`rank_revision >= 0`),
    check('user_article_state_version_check', sql`state_version >= 0`),
    check('user_article_rating_check', sql`rating IN (-1, 1)`),
    check(
      'user_article_reason_check',
      sql`reason IN ('off_topic','clickbait','seen','shallow','promo','other')`,
    ),
    check('user_article_dwell_ms_check', sql`dwell_ms >= 0`),
    check('user_article_capture_generation_check', sql`bookmark_capture_generation >= 0`),
    check(
      'user_article_capture_status_check',
      sql`bookmark_capture_status IN ('pending','saved','partial','failed')`,
    ),
    check(
      'user_article_bookmark_status_pair',
      sql`(bookmarked_at IS NULL) = (bookmark_capture_status IS NULL)`,
    ),
    check(
      'user_article_unbookmarked_clear',
      sql`bookmarked_at IS NOT NULL OR (bookmark_snapshot_id IS NULL AND bookmark_capture_status IS NULL AND bookmark_origin_feed_id IS NULL)`,
    ),
    check(
      'user_article_saved_snapshot',
      sql`bookmark_capture_status NOT IN ('saved','partial') OR bookmark_snapshot_id IS NOT NULL`,
    ),
    check('user_article_rating_pair', sql`(rating IS NULL) = (rated_at IS NULL)`),
    check(
      'user_article_reason_negative',
      sql`reason IS NULL OR (rating IS NOT NULL AND rating = -1)`,
    ),
    index('user_article_lane_idx')
      .on(t.userId, t.lane, t.pLike.desc().nullsLast(), t.articleId.desc().nullsFirst())
      .where(sql`archived_at IS NULL AND read_at IS NULL`),
    index('user_article_bookmarks_idx')
      .on(t.userId, t.bookmarkedAt.desc().nullsFirst())
      .where(sql`bookmarked_at IS NOT NULL`),
  ],
);

export const feedbackEvents = pgTable(
  'feedback_events',
  {
    id: int8('id').primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    articleId: int8('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    value: jsonb('value')
      .notNull()
      .default(sql`'{}'`),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    check(
      'feedback_events_kind_check',
      sql`kind IN ('rate','unrate','open','read','unread','dwell','prompt_answer','bookmark','unbookmark','label','unlabel','mark_read','hide','unhide','undo')`,
    ),
    index('feedback_events_user_idx').on(t.userId, t.createdAt.desc().nullsFirst()),
  ],
);

export const userModels = pgTable(
  'user_models',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    featureSpecSha: text('feature_spec_sha').notNull(),
    nLabels: integer('n_labels').notNull(),
    nPos: integer('n_pos').notNull(),
    nNeg: integer('n_neg').notNull(),
    weights: jsonb('weights').notNull(),
    intercept: real('intercept').notNull(),
    scaler: jsonb('scaler').notNull(),
    calibration: jsonb('calibration').notNull(),
    metrics: jsonb('metrics').notNull(),
    active: boolean('active').notNull().default(false),
    trainedAt: tstz('trained_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'user_models_pkey', columns: [t.userId, t.version] }),
    uniqueIndex('user_models_active_idx')
      .on(t.userId)
      .where(sql`active`),
  ],
);

export const apiMutations = pgTable(
  'api_mutations',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    id: uuid('id').notNull(),
    requestHash: text('request_hash').notNull(),
    route: text('route').notNull(),
    status: integer('status').notNull(),
    response: jsonb('response').notNull(),
    undo: jsonb('undo'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    expiresAt: tstz('expires_at').notNull(),
  },
  (t) => [
    primaryKey({ name: 'api_mutations_pkey', columns: [t.userId, t.id] }),
    check('api_mutations_status_check', sql`status BETWEEN 200 AND 499`),
    check('api_mutations_retention_check', sql`expires_at >= created_at + interval '7 days'`),
    index('api_mutations_expiry_idx').on(t.expiresAt),
  ],
);

export const bookmarkSnapshotPins = pgTable(
  'bookmark_snapshot_pins',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mutationId: uuid('mutation_id').notNull(),
    snapshotId: int8('snapshot_id')
      .notNull()
      .references(() => articleSnapshots.id, { onDelete: 'restrict' }),
    expiresAt: tstz('expires_at').notNull(),
  },
  (t) => [
    primaryKey({
      name: 'bookmark_snapshot_pins_pkey',
      columns: [t.userId, t.mutationId, t.snapshotId],
    }),
    foreignKey({
      name: 'bookmark_snapshot_pins_mutation_fk',
      columns: [t.userId, t.mutationId],
      foreignColumns: [apiMutations.userId, apiMutations.id],
    }).onDelete('cascade'),
    index('bookmark_snapshot_pins_expiry_idx').on(t.expiresAt),
  ],
);

export const cardSuggestions = pgTable(
  'card_suggestions',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    cardId: int8('card_id')
      .notNull()
      .references(() => interestCards.id, { onDelete: 'cascade' }),
    questionSetId: int8('question_set_id')
      .notNull()
      .references(() => questionSets.id),
    modelPin: text('model_pin').notNull(),
    score: real('score').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
    dismissedAt: tstz('dismissed_at'),
  },
  (t) => [
    primaryKey({ name: 'card_suggestions_pkey', columns: [t.userId, t.cardId] }),
    check('card_suggestions_score_check', sql`score BETWEEN 0 AND 1`),
  ],
);
