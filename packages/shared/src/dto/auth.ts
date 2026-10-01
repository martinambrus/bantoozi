import { z } from 'zod';

import { IdSchema } from '../ids.js';

import { IsoTimestampSchema } from './common.js';
import { MeSchema, type Locale } from './me.js';

/** Auth, sessions, invites and waitlist DTOs (spec 08 §2). */

/** RFC 5321 path limit; longer addresses cannot be delivered. */
export const EMAIL_MAX_LENGTH = 254;

/**
 * Trim and lower-case an email the way `citext` compares it (spec 08 §2.1). No provider-specific
 * rewriting (dots, `+tags`): two spellings that a mailbox provider may merge stay distinct.
 */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** A syntactically valid, length-bounded email, normalized with {@link normalizeEmail}. */
export const EmailSchema = z
  .string()
  .max(EMAIL_MAX_LENGTH + 64)
  .transform(normalizeEmail)
  .pipe(z.email().max(EMAIL_MAX_LENGTH));

/** Map a language tag to a supported locale: only `en`/`sk` exist, everything else is `en`. */
export function supportedLocale(tag: string): Locale {
  return tag.trim().slice(0, 2).toLowerCase() === 'sk' ? 'sk' : 'en';
}

/**
 * A requested UI locale: any short language tag is accepted, but only `en`/`sk` are stored;
 * everything else falls back to `en` (spec 08 §2.1).
 */
export const RequestedLocaleSchema = z
  .string()
  .max(35)
  .regex(/^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8})*$/, 'must be a language tag')
  .transform(supportedLocale);

/** Crockford base32 alphabet (no I, L, O, U). */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const INVITE_CODE_LENGTH = 10;
const INVITE_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{10}$/;

/**
 * Canonical form of a typed invite code: upper case without separators, with Crockford's
 * look-alike decoding (`I`/`L` → `1`, `O` → `0`). `null` when it cannot be an invite code.
 */
export function normalizeInviteCode(value: string): string | null {
  const canonical = value
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  return INVITE_CODE_PATTERN.test(canonical) ? canonical : null;
}

/** A sign-in code as typed: 6 digits, whitespace ignored. */
export const LoginCodeSchema = z
  .string()
  .max(32)
  .transform((s) => s.replace(/\s/g, ''))
  .pipe(z.string().regex(/^\d{6}$/, 'must be 6 digits'));

/** `POST /auth/request-code`. A malformed invite code counts as "no valid invite". */
export const RequestCodeBodySchema = z
  .object({
    email: EmailSchema,
    inviteCode: z.string().max(64).optional(),
    locale: RequestedLocaleSchema.optional(),
  })
  .strict();
export type RequestCodeBody = z.infer<typeof RequestCodeBodySchema>;

export const RequestCodeResponseSchema = z.object({ next: z.literal('check_email') }).strict();
export type RequestCodeResponse = z.infer<typeof RequestCodeResponseSchema>;

/** `POST /auth/verify`. */
export const VerifyBodySchema = z.object({ email: EmailSchema, code: LoginCodeSchema }).strict();
export type VerifyBody = z.infer<typeof VerifyBodySchema>;

/** `200` of `POST /auth/verify`. */
export const VerifyResponseSchema = z.object({ user: MeSchema }).strict();
export type VerifyResponse = z.infer<typeof VerifyResponseSchema>;

/** One entry of `GET /auth/sessions`; `id` is the database id, never a token or its hash. */
export const SessionSchema = z
  .object({
    id: IdSchema,
    userAgent: z.string().nullable(),
    ip: z.string().nullable(),
    createdAt: IsoTimestampSchema,
    lastSeenAt: IsoTimestampSchema,
    current: z.boolean(),
  })
  .strict();
export type SessionDto = z.infer<typeof SessionSchema>;
export const SessionListSchema = z.array(SessionSchema);

export const SessionParamsSchema = z.object({ id: IdSchema }).strict();

/** One invite of `GET /invites` (spec 08 §2.2). */
export const InviteSchema = z
  .object({
    code: z.string(),
    email: z.string().nullable(),
    createdAt: IsoTimestampSchema,
    expiresAt: IsoTimestampSchema,
    usedAt: IsoTimestampSchema.nullable(),
    url: z.string(),
  })
  .strict();
export type InviteDto = z.infer<typeof InviteSchema>;

export const InviteListSchema = z
  .object({ items: z.array(InviteSchema), invitesLeft: z.number().int().min(0) })
  .strict();
export type InviteList = z.infer<typeof InviteListSchema>;

export const INVITE_NOTE_MAX_LENGTH = 500;

/** `POST /invites`. */
export const CreateInviteBodySchema = z
  .object({
    email: EmailSchema.optional(),
    note: z.string().trim().max(INVITE_NOTE_MAX_LENGTH).optional(),
  })
  .strict();
export type CreateInviteBody = z.infer<typeof CreateInviteBodySchema>;

/** `201` of `POST /invites`; `emailSent` only when an email was given (absent on a replay). */
export const CreateInviteResponseSchema = z
  .object({ code: z.string(), url: z.string(), emailSent: z.boolean().optional() })
  .strict();
export type CreateInviteResponse = z.infer<typeof CreateInviteResponseSchema>;

/** `POST /waitlist` (public). */
export const WaitlistBodySchema = z
  .object({
    email: EmailSchema,
    locale: RequestedLocaleSchema.optional(),
    note: z.string().trim().max(INVITE_NOTE_MAX_LENGTH).optional(),
  })
  .strict();
export type WaitlistBody = z.infer<typeof WaitlistBodySchema>;

/** `202` of `POST /waitlist`: identical whether or not the address was already listed. */
export const WaitlistResponseSchema = z.object({ next: z.literal('waitlisted') }).strict();
export type WaitlistResponse = z.infer<typeof WaitlistResponseSchema>;
