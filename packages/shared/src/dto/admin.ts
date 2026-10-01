import { z } from 'zod';

import { IdSchema, RevisionSchema, UuidSchema, UuidStringSchema } from '../ids.js';
import { TRANSLATE_SKIP_REASONS } from '../jobs.js';
import { PLAN_NAMES } from '../plans.js';
import { RankerThresholdsSchema } from '../ranker-config.js';
import {
  CardTextModeSchema,
  LanguageModesSchema,
  QuestionSetsActiveSchema,
  SETTINGS,
  SignupModeSchema,
} from '../settings.js';
import { EmailSchema, INVITE_NOTE_MAX_LENGTH, InviteSchema } from './auth.js';
import { IsoTimestampSchema, PageQuerySchema, pageSchema } from './common.js';
import {
  CandidateStatusSchema,
  CredentialErrorCodeSchema,
  ProviderSchema,
} from './provider-credentials.js';

/**
 * Admin, ops and metrics DTOs (spec 08 §9–10). Every request schema is strict and bounded; admin
 * lists default to 30 rows and cap at 100, `days` is 1..90 and a search `q` has at most 200
 * characters (spec 08 §9 "Admin write constraints").
 */

const SearchSchema = z.string().trim().min(1).max(200);
const Usd = z.number().finite().min(0);
const Count = z.number().int().min(0);

// ── Overview and usage ───────────────────────────────────────────────────────────────────────────

export const AdminBreakerSchema = z
  .object({
    state: z.enum(['closed', 'open', 'half_open', 'auth']),
    openUntil: IsoTimestampSchema.nullable(),
    resetRequestedAt: IsoTimestampSchema.nullable(),
  })
  .strict();

export const AdminOverviewSchema = z
  .object({
    users: z.object({ total: Count, active7d: Count }).strict(),
    feeds: z.object({ active: Count, quarantined: Count, dead: Count, paused: Count }).strict(),
    articlesToday: Count,
    /** Pipeline backlog per pg-boss queue (`queue_state_counts()`), aggregate counts only. */
    queues: z.array(
      z
        .object({ queue: z.string(), created: Count, retry: Count, active: Count, failed: Count })
        .strict(),
    ),
    engine: z
      .object({
        breakers: z.object({ typesafe: AdminBreakerSchema, llm: AdminBreakerSchema }).strict(),
        spendTodayUsd: Usd,
        dailyBudgetUsd: Usd,
        /** LLM fallback decision calls today (the `engine.llm_daily_cap` group, D-64). */
        llmCallsToday: Count,
        llmDailyCap: Count,
      })
      .strict(),
    translations: z
      .object({
        /** Translations stored in the last 24 h, by engine and quality. */
        last24h: z.array(
          z
            .object({
              engine: z.enum(['libretranslate', 'ollama']),
              quality: z.enum(['ok', 'weak', 'fail']),
              count: Count,
            })
            .strict(),
        ),
        tier2CallsToday: Count,
        tier2DailyCap: Count,
      })
      .strict(),
  })
  .strict();
export type AdminOverview = z.infer<typeof AdminOverviewSchema>;

export const AdminUsageQuerySchema = z
  .object({ days: z.coerce.number().int().min(1).max(90).default(30) })
  .strict();

export const AdminUsageSchema = z
  .object({
    days: z.number().int().min(1).max(90),
    /** Spend per UTC day, engine and kind (`usage_daily`, all attributions summed). */
    daily: z.array(
      z
        .object({
          day: z.iso.date(),
          engine: z.string(),
          kind: z.string(),
          calls: Count,
          costUsd: Usd,
        })
        .strict(),
    ),
    /** The top 20 users by attributed cost (`admin_usage_attribution`, an estimate). */
    topUsers: z.array(
      z
        .object({
          userId: UuidStringSchema,
          email: z.string().nullable(),
          directUsd: Usd,
          sharedUsd: Usd,
          totalUsd: Usd,
        })
        .strict(),
    ),
  })
  .strict();
export type AdminUsage = z.infer<typeof AdminUsageSchema>;

// ── Settings ─────────────────────────────────────────────────────────────────────────────────────

/** The keys `PATCH /admin/settings` may write (spec 08 §9, spec 02 §2 "admin"). */
export const ADMIN_PATCHABLE_SETTING_KEYS = [
  'engine.daily_budget_usd',
  'engine.llm_daily_cap',
  'engine.prefilter_enabled',
  'engine.laya',
  'language_modes',
  'card_text_mode',
  'ranker.thresholds',
  'translate.tier2_daily_cap',
  'question_sets.active',
  'signup_mode',
] as const;
export type AdminSettingKey = (typeof ADMIN_PATCHABLE_SETTING_KEYS)[number];
export const AdminSettingKeySchema = z.enum(ADMIN_PATCHABLE_SETTING_KEYS);

const settingShape = {
  'engine.daily_budget_usd': SETTINGS['engine.daily_budget_usd'].schema,
  'engine.llm_daily_cap': SETTINGS['engine.llm_daily_cap'].schema,
  'engine.prefilter_enabled': SETTINGS['engine.prefilter_enabled'].schema,
  'engine.laya': SETTINGS['engine.laya'].schema,
  language_modes: LanguageModesSchema,
  card_text_mode: CardTextModeSchema,
  'ranker.thresholds': RankerThresholdsSchema,
  'translate.tier2_daily_cap': SETTINGS['translate.tier2_daily_cap'].schema,
  'question_sets.active': QuestionSetsActiveSchema,
  signup_mode: SignupModeSchema,
} as const;

/** The effective value of every admin key (the stored row, else its default). */
export const AdminSettingsValuesSchema = z.object(settingShape).strict();
export type AdminSettingsValues = z.infer<typeof AdminSettingsValuesSchema>;

export const AdminSettingsSchema = z
  .object({
    values: AdminSettingsValuesSchema,
    /** Keys with a stored row and when it was written; any other key reads its default. */
    stored: z.array(
      z.object({ key: AdminSettingKeySchema, updatedAt: IsoTimestampSchema }).strict(),
    ),
    /** `ranker.settings_version` (read-only; bumped by ranking-relevant changes, spec 06 §7). */
    rankerSettingsVersion: Count,
  })
  .strict();
export type AdminSettings = z.infer<typeof AdminSettingsSchema>;

/** A patch replaces the value of each supplied key; at least one key, unknown keys rejected. */
export const AdminSettingsPatchSchema = z
  .object(settingShape)
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'empty patch');
export type AdminSettingsPatch = z.infer<typeof AdminSettingsPatchSchema>;

export const AdminSettingsPatchResultSchema = AdminSettingsSchema.extend({
  /** Keys whose value actually changed (setting an unchanged value is a no-op). */
  changed: z.array(AdminSettingKeySchema),
}).strict();
export type AdminSettingsPatchResult = z.infer<typeof AdminSettingsPatchResultSchema>;

// ── Engine: breaker reset, translation reprocess, provider credentials ───────────────────────────

export const BreakerEngineSchema = z.enum(['typesafe', 'llm']);
export const ResetBreakerBodySchema = z.object({ engine: BreakerEngineSchema }).strict();
export const ResetBreakerResultSchema = z
  .object({ engine: BreakerEngineSchema, resetRequestedAt: IsoTimestampSchema })
  .strict();

export const TranslationsReprocessBodySchema = z
  .object({ reasons: z.array(z.enum(TRANSLATE_SKIP_REASONS)).min(1).max(3).optional() })
  .strict();
export const QueuedSchema = z.object({ queued: z.literal(true) }).strict();

/** Sanitized capability metadata recorded by `provider.validate` (spec 04 §1.2). */
export const ProviderCapabilitiesSchema = z
  .object({
    model: z.string().nullable(),
    concurrencyLimit: z.number().int().min(1).nullable(),
    flags: z.record(z.string(), z.boolean()),
  })
  .strict();
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

/** `CredentialStatus` (spec 08 §9.1): metadata only, never key material. */
export const CredentialStatusSchema = z
  .object({
    provider: ProviderSchema,
    source: z.enum(['none', 'env', 'db']),
    enabled: z.boolean(),
    revision: RevisionSchema,
    activeVersion: IdSchema.nullable(),
    candidateVersion: IdSchema.nullable(),
    candidateStatus: CandidateStatusSchema.nullable(),
    validatedAt: IsoTimestampSchema.nullable(),
    capabilities: ProviderCapabilitiesSchema.nullable(),
    lastErrorCode: CredentialErrorCodeSchema.nullable(),
  })
  .strict();
export type CredentialStatus = z.infer<typeof CredentialStatusSchema>;

export const ProviderParamsSchema = z.object({ provider: ProviderSchema }).strict();

/** Write-only: `apiKey` is encrypted at once and never returned, logged or stored in receipts. */
export const StageCredentialBodySchema = z
  .object({ apiKey: z.string().min(1).max(4096), expectedRevision: RevisionSchema })
  .strict();
export const CandidateActionBodySchema = z
  .object({ candidateVersion: IdSchema, expectedRevision: RevisionSchema })
  .strict();
export const RevokeCredentialQuerySchema = z.object({ expectedRevision: RevisionSchema }).strict();
export const CredentialListSchema = z.object({ items: z.array(CredentialStatusSchema) }).strict();
export const CredentialResultSchema = z.object({ credential: CredentialStatusSchema }).strict();

// ── Feeds ────────────────────────────────────────────────────────────────────────────────────────

export const FeedStatusSchema = z.enum(['active', 'quarantined', 'dead', 'paused']);

/** `feeds.fetch_options` allowlist (spec 03 §4): a User-Agent override and the tier-2 flag only. */
export const AdminFetchOptionsSchema = z
  .object({
    // Printable ASCII only: no CR/LF header smuggling (spec 08 §9 "Admin write constraints").
    userAgent: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[\x20-\x7e]+$/, 'printable ASCII only')
      .optional(),
    translateStrong: z.boolean().optional(),
  })
  .strict();
export type AdminFetchOptions = z.infer<typeof AdminFetchOptionsSchema>;

export const AdminFeedSchema = z
  .object({
    id: IdSchema,
    url: z.string(),
    siteUrl: z.string().nullable(),
    title: z.string().nullable(),
    status: FeedStatusSchema,
    subscriberCount: Count,
    consecutiveErrors: Count,
    quarantineCount: Count,
    quarantinedUntil: IsoTimestampSchema.nullable(),
    lastSuccessAt: IsoTimestampSchema.nullable(),
    lastErrorCode: z.string().nullable(),
    lastErrorAt: IsoTimestampSchema.nullable(),
    nextFetchAt: IsoTimestampSchema,
    minIntervalS: z.number().int().min(1),
    mergedIntoId: IdSchema.nullable(),
    fetchOptions: AdminFetchOptionsSchema,
  })
  .strict();
export type AdminFeed = z.infer<typeof AdminFeedSchema>;

export const AdminFeedsQuerySchema = PageQuerySchema.extend({
  status: FeedStatusSchema.optional(),
  q: SearchSchema.optional(),
}).strict();
export const AdminFeedPageSchema = pageSchema(AdminFeedSchema);
export const AdminIdParamsSchema = z.object({ id: IdSchema }).strict();
export const AdminFeedPatchSchema = z.object({ fetchOptions: AdminFetchOptionsSchema }).strict();
export const AdminFeedResultSchema = z.object({ feed: AdminFeedSchema }).strict();

// ── Users, invites, waitlist ─────────────────────────────────────────────────────────────────────

export const AdminUserSchema = z
  .object({
    id: UuidStringSchema,
    email: z.string(),
    displayName: z.string().nullable(),
    role: z.enum(['user', 'admin']),
    plan: z.string(),
    invitesLeft: Count,
    createdAt: IsoTimestampSchema,
    lastActiveAt: IsoTimestampSchema.nullable(),
    deletedAt: IsoTimestampSchema.nullable(),
    /** Listed in `ADMIN_EMAILS`: a demotion lasts only until the next login (spec 08 §2.1). */
    adminBootstrap: z.boolean(),
  })
  .strict();
export type AdminUser = z.infer<typeof AdminUserSchema>;

export const AdminUsersQuerySchema = PageQuerySchema.extend({
  q: SearchSchema.optional(),
}).strict();
export const AdminUserPageSchema = pageSchema(AdminUserSchema);
export const AdminUserParamsSchema = z.object({ id: UuidSchema }).strict();
export const AdminUserPatchSchema = z
  .object({
    role: z.enum(['user', 'admin']).optional(),
    plan: z.enum(PLAN_NAMES).optional(),
    invitesLeft: z.number().int().min(0).max(10_000).optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'empty patch');
export type AdminUserPatch = z.infer<typeof AdminUserPatchSchema>;
export const AdminUserResultSchema = z
  .object({ user: AdminUserSchema, sessionsRevoked: Count })
  .strict();

export const AdminInviteStatusSchema = z.enum(['unused', 'used', 'expired']);
export const AdminInviteSchema = z
  .object({
    code: z.string(),
    email: z.string().nullable(),
    note: z.string().nullable(),
    createdBy: UuidStringSchema.nullable(),
    createdAt: IsoTimestampSchema,
    expiresAt: IsoTimestampSchema,
    usedBy: UuidStringSchema.nullable(),
    usedAt: IsoTimestampSchema.nullable(),
    status: AdminInviteStatusSchema,
  })
  .strict();
export const AdminInvitesQuerySchema = PageQuerySchema.extend({
  status: AdminInviteStatusSchema.optional(),
}).strict();
export const AdminInvitePageSchema = pageSchema(AdminInviteSchema);

export const AdminWaitlistEntrySchema = z
  .object({
    id: IdSchema,
    email: z.string(),
    locale: z.enum(['en', 'sk']),
    note: z.string().nullable(),
    createdAt: IsoTimestampSchema,
    invitedAt: IsoTimestampSchema.nullable(),
    inviteCode: z.string().nullable(),
  })
  .strict();
export const AdminWaitlistQuerySchema = PageQuerySchema;
export const AdminWaitlistPageSchema = pageSchema(AdminWaitlistEntrySchema);

/** At most this many invites per `POST /admin/invites` (spec 08 §9). */
export const ADMIN_INVITE_MAX_COUNT = 50;
export const ADMIN_INVITE_MAX_EXPIRES_DAYS = 90;

/**
 * `POST /admin/invites`: `{count ≤ 50, email?, note?, expiresDays ≤ 90}`. An email binds the invite
 * and is sent one invite, so it requires `count` 1.
 */
export const AdminCreateInvitesBodySchema = z
  .object({
    count: z.number().int().min(1).max(ADMIN_INVITE_MAX_COUNT).default(1),
    email: EmailSchema.optional(),
    note: z.string().trim().max(INVITE_NOTE_MAX_LENGTH).optional(),
    expiresDays: z.number().int().min(1).max(ADMIN_INVITE_MAX_EXPIRES_DAYS).optional(),
  })
  .strict()
  .refine((body) => body.email === undefined || body.count === 1, {
    message: 'an email-bound invite is created one at a time',
    path: ['count'],
  });
export type AdminCreateInvitesBody = z.infer<typeof AdminCreateInvitesBodySchema>;

export const AdminCreateInvitesResultSchema = z
  .object({ items: z.array(InviteSchema), emailSent: z.boolean().optional() })
  .strict();
export type AdminCreateInvitesResult = z.infer<typeof AdminCreateInvitesResultSchema>;

export const AdminWaitlistParamsSchema = z.object({ id: IdSchema }).strict();

/**
 * `POST /admin/waitlist/:id/invite`. `emailSent` reports this request's delivery; a replayed
 * receipt omits it (the email is never re-sent), as `POST /invites` does.
 */
export const AdminWaitlistInviteResultSchema = z
  .object({
    entry: AdminWaitlistEntrySchema,
    invite: InviteSchema,
    emailSent: z.boolean().optional(),
  })
  .strict();
export type AdminWaitlistInviteResult = z.infer<typeof AdminWaitlistInviteResultSchema>;

// ── Library, candidates and promotion (spec 08 §9.2, spec 05 §8.1) ───────────────────────────────

const TopicIdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,40}(?:\.[a-z][a-z0-9_]{0,40})?$/);
const TopicIdsSchema = z.array(TopicIdSchema).max(10);
export const LibrarySlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/);
const Title = z.string().trim().min(1).max(60);
export const AuthorizationKindSchema = z.enum(['creator_approval', 'creator_inactive_30d']);

/**
 * Advisory promotion eligibility (spec 08 §9.2): the basis a promotion would use now, or why it is
 * held. The promotion transaction rechecks everything under locks.
 */
export const PromotionEligibilitySchema = z
  .object({
    status: z.enum(['eligible', 'held', 'promoted']),
    basis: AuthorizationKindSchema.nullable(),
    reason: z
      .enum([
        'no_request',
        'insufficient_holders',
        'unknown_creator',
        'declined',
        'awaiting_approval',
        'expired',
        'stale_payload',
      ])
      .nullable(),
  })
  .strict();
export type PromotionEligibility = z.infer<typeof PromotionEligibilitySchema>;

/** The exact proposed public listing the original creator is asked about. */
export const PromotionPayloadSchema = z
  .object({
    slug: z.string().nullable(),
    title: z.string().nullable(),
    titleSk: z.string().nullable(),
    topicIds: z.array(z.string()),
  })
  .strict();

export const PromotionRequestSchema = z
  .object({
    id: IdSchema,
    cardId: IdSchema,
    cardTitle: z.string(),
    status: z.enum(['pending', 'approved', 'rejected', 'expired', 'promoted']),
    version: IdSchema,
    requestedAt: IsoTimestampSchema,
    expiresAt: IsoTimestampSchema.nullable(),
    respondedAt: IsoTimestampSchema.nullable(),
    payload: PromotionPayloadSchema,
    publicationSha: z.string(),
    holders: Count,
    creatorKnown: z.boolean(),
    vetoed: z.boolean(),
    promotionEligibility: PromotionEligibilitySchema,
    authorizationKind: AuthorizationKindSchema.nullable(),
    promotedAt: IsoTimestampSchema.nullable(),
  })
  .strict();
export type PromotionRequest = z.infer<typeof PromotionRequestSchema>;

export const LibraryCandidatesQuerySchema = z
  .object({ minHolders: z.coerce.number().int().min(1).max(1_000_000).default(3) })
  .strict();

export const LibraryCandidateSchema = z
  .object({
    cardId: IdSchema,
    title: z.string(),
    interest: z.string(),
    notFor: z.string().nullable(),
    lang: z.string(),
    topicIds: z.array(z.string()),
    holders: Count,
    createdAt: IsoTimestampSchema,
    creatorKnown: z.boolean(),
    vetoed: z.boolean(),
    /** The card's open (pending/approved) request, if any. */
    request: PromotionRequestSchema.nullable(),
    promotionEligibility: PromotionEligibilitySchema,
  })
  .strict();
export type LibraryCandidate = z.infer<typeof LibraryCandidateSchema>;
export const LibraryCandidatesSchema = z
  .object({ items: z.array(LibraryCandidateSchema) })
  .strict();

export const PromotionRequestBodySchema = z
  .object({
    cardId: IdSchema,
    title: Title,
    titleSk: Title.optional(),
    topicIds: TopicIdsSchema,
    slug: LibrarySlugSchema.optional(),
  })
  .strict();
export const PromotionRequestResultSchema = z.object({ request: PromotionRequestSchema }).strict();

export const PromoteBodySchema = z
  .object({ requestId: IdSchema, expectedVersion: IdSchema })
  .strict();
export const PromoteResultSchema = z
  .object({
    request: PromotionRequestSchema,
    cardId: IdSchema,
    authorizationKind: AuthorizationKindSchema,
  })
  .strict();

/** Request form: trimmed and bounded. */
export const LibraryI18nSchema = z
  .object({
    sk: z
      .object({
        title: Title.optional(),
        interest: z.string().trim().min(3).max(300).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
/** Response form: the same shape without input normalization (responses are encoded as is). */
export const LibraryI18nOutSchema = z
  .object({
    sk: z
      .object({ title: z.string().optional(), interest: z.string().optional() })
      .strict()
      .optional(),
  })
  .strict();
export type LibraryI18n = z.infer<typeof LibraryI18nSchema>;

export const AdminLibraryCardSchema = z
  .object({
    cardId: IdSchema,
    slug: z.string().nullable(),
    version: z.number().int().min(1).nullable(),
    title: z.string(),
    interest: z.string(),
    notFor: z.string().nullable(),
    examplesYes: z.array(z.string()),
    examplesNo: z.array(z.string()),
    topicIds: z.array(z.string()),
    i18n: LibraryI18nOutSchema,
    holders: Count,
    retiredAt: IsoTimestampSchema.nullable(),
    createdAt: IsoTimestampSchema,
  })
  .strict();
export type AdminLibraryCard = z.infer<typeof AdminLibraryCardSchema>;
export const AdminLibraryQuerySchema = PageQuerySchema.extend({
  q: SearchSchema.optional(),
}).strict();
export const AdminLibraryPageSchema = pageSchema(AdminLibraryCardSchema);

const Interest = z.string().trim().min(3).max(300);
const NotFor = z.string().trim().min(1).max(300);
const Examples = z.array(z.string().trim().min(1).max(200)).max(5);

export const AdminLibraryCreateSchema = z
  .object({
    slug: LibrarySlugSchema,
    title: Title,
    interest: Interest,
    notFor: NotFor.optional(),
    examplesYes: Examples.optional(),
    examplesNo: Examples.optional(),
    topicIds: TopicIdsSchema,
    i18n: LibraryI18nSchema.optional(),
  })
  .strict();
export type AdminLibraryCreate = z.infer<typeof AdminLibraryCreateSchema>;

/**
 * Display metadata (`title`, `topicIds`, `i18n`, `retired`) changes in place; a semantic field
 * (`interest`, `notFor`, examples) creates the next immutable library version, which takes the
 * slug, and never touches existing holders (spec 05 §8, spec 02 §3.6).
 */
export const AdminLibraryPatchSchema = z
  .object({
    title: Title.optional(),
    topicIds: TopicIdsSchema.optional(),
    i18n: LibraryI18nSchema.optional(),
    retired: z.boolean().optional(),
    interest: Interest.optional(),
    notFor: NotFor.nullable().optional(),
    examplesYes: Examples.optional(),
    examplesNo: Examples.optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'empty patch');
export type AdminLibraryPatch = z.infer<typeof AdminLibraryPatchSchema>;
export const AdminLibraryResultSchema = z
  .object({
    card: AdminLibraryCardSchema,
    /** Set when a semantic change created a new version (existing holders keep the old card). */
    idChange: z.object({ from: IdSchema, to: IdSchema }).strict().nullable(),
  })
  .strict();

// ── Ops events (bearer METRICS_TOKEN) ────────────────────────────────────────────────────────────

/** spec 11 §6.1: the bounded structured host capacity/heartbeat payload of `host_health`. */
export const HostHealthDetailSchema = z
  .object({
    host: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,64}$/)
      .optional(),
    checkedAt: IsoTimestampSchema.optional(),
    filesystems: z
      .array(
        z
          .object({
            mount: z.string().regex(/^\/[A-Za-z0-9._/-]{0,99}$/),
            usedPct: z.number().min(0).max(100),
            freeBytes: z.number().int().min(0),
            inodesUsedPct: z.number().min(0).max(100).optional(),
          })
          .strict(),
      )
      .max(8)
      .optional(),
    heartbeats: z
      .record(z.string().regex(/^[a-z][a-z0-9_.-]{0,40}$/), IsoTimestampSchema)
      .refine((h) => Object.keys(h).length <= 16, 'too many heartbeats')
      .optional(),
  })
  .strict();

// eslint-disable-next-line no-control-regex -- redacted script output: no control characters
const NO_CONTROL_CHARS = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f]*$/;
const OpsTextDetail = z.string().max(2000).regex(NO_CONTROL_CHARS);

export const OpsEventBodySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.enum(['backup_ok', 'backup_failed', 'restore_ok', 'restore_failed']),
      detail: OpsTextDetail.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('host_health'), detail: HostHealthDetailSchema }).strict(),
]);
export type OpsEventBody = z.infer<typeof OpsEventBodySchema>;
export const OpsEventResultSchema = z
  .object({ kind: z.string(), at: IsoTimestampSchema, stored: Count })
  .strict();

// ── Dev mail (registered only when NODE_ENV=test) ────────────────────────────────────────────────

export const DevLastEmailSchema = z
  .object({
    email: z.object({ to: z.string(), subject: z.string(), text: z.string() }).strict().nullable(),
  })
  .strict();
