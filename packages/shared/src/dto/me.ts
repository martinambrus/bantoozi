import { z } from 'zod';

import { UuidSchema } from '../ids.js';
import { PLAN_NAMES } from '../plans.js';
import { UserPreferencesSchema } from '../preferences.js';

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
    id: UuidSchema,
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
