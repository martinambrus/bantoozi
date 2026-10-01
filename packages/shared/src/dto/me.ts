import { z } from 'zod';

import { UuidStringSchema } from '../ids.js';
import { PLAN_NAMES } from '../plans.js';
import { UserPreferencesPatchSchema, UserPreferencesSchema } from '../preferences.js';
import { IsoTimestampSchema } from './common.js';

/** Me, preferences and export DTOs (spec 08 §3). */

/** The quota limits reported in `Me.quotas` (spec 08 §6); `opmlMaxFeeds` is per import. */
export const QUOTA_LIMIT_NAMES = [
  'maxFeeds',
  'maxCards',
  'maxLabels',
  'maxForks',
  'maxRules',
  'opmlMaxFeeds',
] as const;
export type QuotaLimitName = (typeof QUOTA_LIMIT_NAMES)[number];

/** Current usage of the counted limits (`opmlMaxFeeds` applies per import and has no usage). */
export const QuotaUsageSchema = z
  .object({
    maxFeeds: z.number().int().min(0),
    maxCards: z.number().int().min(0),
    maxLabels: z.number().int().min(0),
    maxForks: z.number().int().min(0),
    maxRules: z.number().int().min(0),
  })
  .strict();
export type QuotaUsage = z.infer<typeof QuotaUsageSchema>;

export const QuotaLimitsSchema = z
  .object(
    Object.fromEntries(QUOTA_LIMIT_NAMES.map((name) => [name, z.number().int().min(0)])) as Record<
      QuotaLimitName,
      z.ZodNumber
    >,
  )
  .strict();
export type QuotaLimits = z.infer<typeof QuotaLimitsSchema>;

export const UserRoleSchema = z.enum(['user', 'admin']);
export const LocaleSchema = z.enum(['en', 'sk']);
export type Locale = z.infer<typeof LocaleSchema>;

/** `Me` (spec 08 §3): the signed-in user, returned by `GET /me` and `POST /auth/verify`. */
export const MeSchema = z
  .object({
    id: UuidStringSchema,
    email: z.string(),
    displayName: z.string().nullable(),
    locale: LocaleSchema,
    timezone: z.string(),
    role: UserRoleSchema,
    /** A defined plan key; an unknown stored plan reads as its fallback limits. */
    plan: z.union([z.enum(PLAN_NAMES), z.string()]),
    invitesLeft: z.number().int().min(0),
    preferences: UserPreferencesSchema,
    quotas: z.object({ used: QuotaUsageSchema, limits: QuotaLimitsSchema }).strict(),
  })
  .strict();
export type Me = z.infer<typeof MeSchema>;

/** Longest display name. */
export const MAX_DISPLAY_NAME_LENGTH = 100;

const IANA_TIME_ZONE = /^(?:UTC|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2})$/;

/**
 * An accepted IANA time zone identifier (spec 08 §3 `PATCH /me`): an `Area/Location` name (or
 * `UTC`) that the runtime's time zone database resolves. Offsets such as `+01:00` are rejected.
 */
export function isIanaTimeZone(value: string): boolean {
  if (value.length > 64 || !IANA_TIME_ZONE.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** `PATCH /me` (spec 08 §3): only supplied fields change; an empty patch fails validation. */
export const MePatchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(MAX_DISPLAY_NAME_LENGTH).nullable(),
    locale: LocaleSchema,
    timezone: z.string().refine(isIanaTimeZone, 'must be an IANA time zone'),
    preferences: UserPreferencesPatchSchema,
  })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'empty patch');
export type MePatch = z.infer<typeof MePatchSchema>;

/** Version of the `GET /me/export` document (spec 08 §3). */
export const EXPORT_SCHEMA_VERSION = 2;

/** `BookmarkCapture` as exported (spec 08 §5.2). */
export const ExportBookmarkCaptureSchema = z
  .object({
    status: z.enum(['pending', 'saved', 'partial', 'failed']),
    generation: z.string(),
    snapshotId: z.string().nullable(),
    capturedAt: IsoTimestampSchema.nullable(),
    errorCode: z.string().nullable(),
  })
  .strict();

/** `BookmarkSnapshot` as exported (spec 08 §5.2): the full retained text and sanitized HTML. */
export const ExportBookmarkSnapshotSchema = z
  .object({
    id: z.string(),
    sourceUrl: z.string().nullable(),
    title: z.string(),
    author: z.string().nullable(),
    publishedAt: IsoTimestampSchema.nullable(),
    capturedAt: IsoTimestampSchema,
    contentRevision: z.string(),
    completeness: z.enum(['complete', 'partial']),
    text: z.string(),
    html: z.string().nullable(),
    mediaPolicyFeedId: z.string().nullable(),
    effectiveImagesAllowed: z.boolean(),
  })
  .strict();

/**
 * The `GET /me/export` document (spec 08 §3), version 2: the user's own data only, never
 * session/code/token/provider secrets or another user's data. Streamed as an attachment; this schema
 * documents and tests its shape.
 */
export const MeExportSchema = z
  .object({
    schemaVersion: z.literal(EXPORT_SCHEMA_VERSION),
    exportedAt: IsoTimestampSchema,
    user: z
      .object({
        id: UuidStringSchema,
        email: z.string(),
        displayName: z.string().nullable(),
        locale: LocaleSchema,
        timezone: z.string(),
        role: UserRoleSchema,
        plan: z.string(),
        createdAt: IsoTimestampSchema,
        preferences: UserPreferencesSchema,
      })
      .strict(),
    subscriptions: z.array(
      z
        .object({
          feedId: z.string(),
          url: z.string(),
          siteUrl: z.string().nullable(),
          title: z.string().nullable(),
          titleOverride: z.string().nullable(),
          folder: z.string().nullable(),
          allowDuplicates: z.boolean(),
          hidden: z.boolean(),
          inferenceMode: z.enum(['off', 'training', 'active']),
          imagePolicy: z.enum(['inherit', 'allow', 'block']),
          createdAt: IsoTimestampSchema,
        })
        .strict(),
    ),
    feedPreferences: z.array(
      z.object({ feedId: z.string(), imagePolicy: z.enum(['inherit', 'allow', 'block']) }).strict(),
    ),
    /** The subscriptions as OPML 2.0 (spec 03 §11). */
    opml: z.string(),
    cards: z.array(
      z
        .object({
          id: z.string(),
          title: z.string(),
          titleOverride: z.string().nullable(),
          strength: z.enum(['must', 'love', 'like', 'never']),
          scopeFeedId: z.string().nullable(),
          interest: z.string(),
          notFor: z.string().nullable(),
          examplesYes: z.array(z.string()),
          examplesNo: z.array(z.string()),
          lang: z.string(),
          visibility: z.enum(['public', 'shared', 'private']),
          createdAt: IsoTimestampSchema,
        })
        .strict(),
    ),
    labels: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          color: z.string(),
          definition: z.string(),
          notFor: z.string().nullable(),
          examplesYes: z.array(z.string()),
          examplesNo: z.array(z.string()),
          createdAt: IsoTimestampSchema,
        })
        .strict(),
    ),
    rules: z.array(
      z
        .object({
          id: z.string(),
          kind: z.string(),
          value: z.string(),
          createdAt: IsoTimestampSchema,
          expiresAt: IsoTimestampSchema.nullable(),
        })
        .strict(),
    ),
    ratings: z.array(
      z
        .object({
          url: z.string().nullable(),
          title: z.string(),
          rating: z.union([z.literal(1), z.literal(-1)]),
          reason: z.string().nullable(),
          ratedAt: IsoTimestampSchema,
        })
        .strict(),
    ),
    bookmarks: z.array(
      z
        .object({
          url: z.string().nullable(),
          title: z.string(),
          bookmarkedAt: IsoTimestampSchema,
          capture: ExportBookmarkCaptureSchema,
          snapshot: ExportBookmarkSnapshotSchema.nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type MeExport = z.infer<typeof MeExportSchema>;
