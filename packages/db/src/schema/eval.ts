import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  smallint,
  text,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { articles, feeds } from './articles.js';
import { int8, tstz } from './columns.js';
import { interestCards } from './models.js';

// Spec 02 §7: the evaluation schema (M3a). Only `apps/eval` reads and writes it, through the worker
// role; grants, default privileges and the append-only dataset triggers are hand-written in the
// same migration. `eval.datasets` is an addition (D-96): it records each dataset version's sampling
// parameters and, once its first run freezes it, the manifest hashes.

export const evalSchema = pgSchema('eval');

export const evalDatasets = evalSchema.table(
  'datasets',
  {
    version: text('version').primaryKey(),
    parentVersion: text('parent_version').references((): AnyPgColumn => evalDatasets.version, {
      onDelete: 'restrict',
    }),
    seed: text('seed').notNull(),
    params: jsonb('params').notNull(),
    manifest: jsonb('manifest'),
    snapshotSha: text('snapshot_sha'),
    splitSha: text('split_sha'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    frozenAt: tstz('frozen_at'),
  },
  () => [
    check('datasets_version_check', sql`version ~ '^[a-z0-9][a-z0-9._-]{0,63}$'`),
    check(
      'datasets_frozen_check',
      sql`(frozen_at IS NULL) = (manifest IS NULL) AND (frozen_at IS NULL) = (snapshot_sha IS NULL)
          AND (frozen_at IS NULL) = (split_sha IS NULL)`,
    ),
  ],
);

export const evalRaters = evalSchema.table(
  'raters',
  {
    id: int8('id').primaryKey().generatedAlwaysAsIdentity(),
    name: text('name').notNull(),
    participantKey: uuid('participant_key').notNull(),
    contextName: text('context_name'),
    tokenHash: text('token_hash').notNull().unique(),
    tokenExpiresAt: tstz('token_expires_at').notNull(),
    tokenRevokedAt: tstz('token_revoked_at'),
    langs: text('langs').array().notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  () => [check('raters_langs_check', sql`cardinality(langs) >= 1`)],
);

export const evalRaterSessions = evalSchema.table(
  'rater_sessions',
  {
    sessionHash: text('session_hash').primaryKey(),
    raterId: int8('rater_id')
      .notNull()
      .references(() => evalRaters.id, { onDelete: 'cascade' }),
    createdAt: tstz('created_at').notNull().defaultNow(),
    expiresAt: tstz('expires_at').notNull(),
  },
  (t) => [index('rater_sessions_rater_idx').on(t.raterId)],
);

export const evalRaterCards = evalSchema.table(
  'rater_cards',
  {
    raterId: int8('rater_id').references(() => evalRaters.id, { onDelete: 'cascade' }),
    cardId: int8('card_id').references(() => interestCards.id, { onDelete: 'restrict' }),
    strength: text('strength').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.raterId, t.cardId] }),
    check('rater_cards_strength_check', sql`strength IN ('must','love','like','never')`),
  ],
);

export const evalRaterFeeds = evalSchema.table(
  'rater_feeds',
  {
    raterId: int8('rater_id').references(() => evalRaters.id, { onDelete: 'cascade' }),
    feedId: int8('feed_id').references(() => feeds.id, { onDelete: 'restrict' }),
  },
  (t) => [primaryKey({ columns: [t.raterId, t.feedId] })],
);

export const evalAssignments = evalSchema.table(
  'assignments',
  {
    raterId: int8('rater_id').references(() => evalRaters.id, { onDelete: 'cascade' }),
    articleId: int8('article_id').references(() => articles.id, { onDelete: 'restrict' }),
    position: integer('position').notNull(),
    status: text('status').notNull().default('pending'),
    skipReason: text('skip_reason'),
  },
  (t) => [
    primaryKey({ columns: [t.raterId, t.articleId] }),
    unique('assignments_rater_id_position_key').on(t.raterId, t.position),
    check('assignments_position_check', sql`position >= 0`),
    check('assignments_status_check', sql`status IN ('pending','rated','skipped')`),
    check(
      'assignments_skip_reason_check',
      sql`skip_reason IS NULL OR (status = 'skipped' AND length(skip_reason) <= 500)`,
    ),
  ],
);

export const evalRatings = evalSchema.table(
  'ratings',
  {
    raterId: int8('rater_id').references(() => evalRaters.id, { onDelete: 'cascade' }),
    articleId: int8('article_id').references(() => articles.id, { onDelete: 'restrict' }),
    rating: smallint('rating').notNull(),
    reason: text('reason'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.raterId, t.articleId] }),
    check('ratings_rating_check', sql`rating IN (-1, 1)`),
  ],
);

export const evalFacetLabels = evalSchema.table(
  'facet_labels',
  {
    labeler: text('labeler').notNull(),
    articleId: int8('article_id').references(() => articles.id, { onDelete: 'restrict' }),
    questionKey: text('question_key').notNull(),
    value: text('value').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.articleId, t.questionKey, t.labeler] })],
);

export const evalSample = evalSchema.table(
  'sample',
  {
    datasetVersion: text('dataset_version')
      .notNull()
      .references(() => evalDatasets.version, { onDelete: 'restrict' }),
    articleId: int8('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'restrict' }),
    lang: text('lang').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    snapshotSha: text('snapshot_sha').notNull(),
    split: text('split').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.datasetVersion, t.articleId] }),
    check('sample_split_check', sql`split IN ('dev','test')`),
  ],
);

export const evalRuns = evalSchema.table('runs', {
  id: int8('id').primaryKey().generatedAlwaysAsIdentity(),
  experiment: text('experiment').notNull(),
  datasetVersion: text('dataset_version')
    .notNull()
    .references(() => evalDatasets.version, { onDelete: 'restrict' }),
  config: jsonb('config').notNull(),
  gitSha: text('git_sha').notNull(),
  startedAt: tstz('started_at').notNull().defaultNow(),
  finishedAt: tstz('finished_at'),
  results: jsonb('results'),
});

export const evalRunAnswers = evalSchema.table(
  'run_answers',
  {
    runId: int8('run_id')
      .notNull()
      .references(() => evalRuns.id, { onDelete: 'cascade' }),
    articleId: int8('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'restrict' }),
    cardId: int8('card_id').references(() => interestCards.id, { onDelete: 'restrict' }),
    questionKey: text('question_key').notNull(),
    answer: jsonb('answer').notNull(),
  },
  (t) => [
    unique('run_answers_run_id_article_id_card_id_question_key_key')
      .on(t.runId, t.articleId, t.cardId, t.questionKey)
      .nullsNotDistinct(),
    index('run_answers_run_idx').on(t.runId, t.articleId),
  ],
);
