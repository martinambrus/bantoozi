import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { citext, int8, tstz } from './columns.js';

// Spec 02 §2 and §2.1: settings and accounts (auth/control-plane tables: no tenant RLS, §1.2).

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    email: citext('email').notNull().unique(),
    displayName: text('display_name'),
    locale: text('locale').notNull().default('en'),
    timezone: text('timezone').notNull().default('Europe/Bratislava'),
    role: text('role').notNull().default('user'),
    plan: text('plan').notNull().default('beta'),
    invitesLeft: integer('invites_left').notNull().default(3),
    rankRevision: int8('rank_revision')
      .notNull()
      .default(sql`0`),
    suggestLeaseToken: uuid('suggest_lease_token'),
    suggestLeaseUntil: tstz('suggest_lease_until'),
    lastSuggestedAt: tstz('last_suggested_at'),
    preferences: jsonb('preferences')
      .notNull()
      .default(sql`'{}'`),
    createdAt: tstz('created_at').notNull().defaultNow(),
    lastActiveAt: tstz('last_active_at'),
    deletedAt: tstz('deleted_at'),
  },
  () => [
    check('users_locale_check', sql`locale IN ('en','sk')`),
    check('users_role_check', sql`role IN ('user','admin')`),
    check('users_invites_left_check', sql`invites_left >= 0`),
    check('users_rank_revision_check', sql`rank_revision >= 0`),
    check(
      'users_suggest_lease_check',
      sql`(suggest_lease_token IS NULL) = (suggest_lease_until IS NULL)`,
    ),
  ],
);

export const settings = pgTable(
  'settings',
  {
    key: text('key').primaryKey(),
    value: jsonb('value').notNull(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
    updatedBy: uuid('updated_by'),
  },
  (t) => [
    foreignKey({
      name: 'settings_updated_by_fk',
      columns: [t.updatedBy],
      foreignColumns: [users.id],
    }).onDelete('set null'),
  ],
);

export const loginCodes = pgTable(
  'login_codes',
  {
    id: int8('id').primaryKey().generatedAlwaysAsIdentity(),
    email: citext('email').notNull(),
    challengeNonce: uuid('challenge_nonce').notNull().unique(),
    codeHash: text('code_hash').notNull(),
    purpose: text('purpose').notNull(),
    loginUserId: uuid('login_user_id').references(() => users.id, { onDelete: 'cascade' }),
    inviteCode: text('invite_code'),
    locale: text('locale'),
    expiresAt: tstz('expires_at').notNull(),
    attempts: integer('attempts').notNull().default(0),
    consumedAt: tstz('consumed_at'),
    requestedIp: inet('requested_ip'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('login_codes_purpose_check', sql`purpose IN ('login','signup')`),
    check('login_codes_attempts_check', sql`attempts BETWEEN 0 AND 5`),
    check('login_codes_login_user_check', sql`(purpose = 'login') = (login_user_id IS NOT NULL)`),
    check('login_codes_expiry_check', sql`expires_at > created_at`),
    index('login_codes_email_idx').on(t.email, t.createdAt.desc().nullsFirst()),
    uniqueIndex('login_codes_active_email_idx')
      .on(t.email)
      .where(sql`consumed_at IS NULL`),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: int8('id').primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    userAgent: text('user_agent'),
    ip: inet('ip'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
    expiresAt: tstz('expires_at').notNull(),
    revokedAt: tstz('revoked_at'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const invites = pgTable('invites', {
  code: text('code').primaryKey(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  email: citext('email'),
  note: text('note'),
  createdAt: tstz('created_at').notNull().defaultNow(),
  expiresAt: tstz('expires_at').notNull(),
  usedBy: uuid('used_by').references(() => users.id, { onDelete: 'set null' }),
  usedAt: tstz('used_at'),
});

export const waitlist = pgTable(
  'waitlist',
  {
    id: int8('id').primaryKey().generatedAlwaysAsIdentity(),
    email: citext('email').notNull().unique(),
    locale: text('locale').notNull().default('en'),
    note: text('note'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    invitedAt: tstz('invited_at'),
    inviteCode: text('invite_code').references(() => invites.code, { onDelete: 'set null' }),
  },
  () => [check('waitlist_locale_check', sql`locale IN ('en','sk')`)],
);

export const rateLimitBuckets = pgTable(
  'rate_limit_buckets',
  {
    key: text('key').primaryKey(),
    windowStart: tstz('window_start').notNull(),
    hits: integer('hits').notNull(),
  },
  () => [check('rate_limit_buckets_hits_check', sql`hits > 0`)],
);

export const providerCredentials = pgTable(
  'provider_credentials',
  {
    provider: text('provider').primaryKey(),
    revision: int8('revision')
      .notNull()
      .default(sql`0`),
    enabled: boolean('enabled').notNull().default(false),
    activeVersion: int8('active_version'),
    activeEnvelope: jsonb('active_envelope'),
    candidateVersion: int8('candidate_version'),
    candidateEnvelope: jsonb('candidate_envelope'),
    candidateStatus: text('candidate_status'),
    candidateValidation: jsonb('candidate_validation')
      .notNull()
      .default(sql`'{}'`),
    validationToken: uuid('validation_token'),
    validationUntil: tstz('validation_until'),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    activatedAt: tstz('activated_at'),
    validatedAt: tstz('validated_at'),
    lastErrorCode: text('last_error_code'),
  },
  () => [
    check('provider_credentials_provider_check', sql`provider IN ('typesafe','ollama')`),
    check('provider_credentials_revision_check', sql`revision >= 0`),
    check('provider_credentials_active_version_check', sql`active_version > 0`),
    check('provider_credentials_candidate_version_check', sql`candidate_version > 0`),
    check(
      'provider_credentials_candidate_status_check',
      sql`candidate_status IN ('pending','validating','valid','invalid')`,
    ),
    check(
      'provider_credentials_active_pair',
      sql`(active_version IS NULL) = (active_envelope IS NULL)`,
    ),
    check(
      'provider_credentials_candidate_pair',
      sql`(candidate_version IS NULL) = (candidate_envelope IS NULL)`,
    ),
    check(
      'provider_credentials_candidate_status_pair',
      sql`(candidate_version IS NULL) = (candidate_status IS NULL)`,
    ),
    check(
      'provider_credentials_validation_pair',
      sql`(validation_token IS NULL) = (validation_until IS NULL)`,
    ),
    check(
      'provider_credentials_validating_token',
      sql`coalesce(candidate_status = 'validating', false) = (validation_token IS NOT NULL)`,
    ),
    check('provider_credentials_enabled_active', sql`NOT enabled OR active_version IS NOT NULL`),
    check(
      'provider_credentials_active_le_revision',
      sql`active_version IS NULL OR active_version <= revision`,
    ),
    check(
      'provider_credentials_candidate_le_revision',
      sql`candidate_version IS NULL OR candidate_version <= revision`,
    ),
  ],
);
