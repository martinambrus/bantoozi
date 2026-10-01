import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  bindTenant,
  consumeInvite,
  consumeLoginCode,
  createSession,
  deleteWaitlistEntry,
  findUsableInvite,
  findUserByEmail,
  insertSignupUser,
  issueLoginCode,
  lockActiveLoginCode,
  lockAuthEmail,
  lockUserForVerify,
  readStoredSetting,
  recordFailedLoginAttempt,
  recordVerifiedLogin,
  restoreSoftDeletedUser,
  type Executor,
} from '@bantoozi/db';
import {
  DEFAULT_PLAN,
  newUserId,
  normalizeInviteCode,
  planLimits,
  readSetting,
  supportedLocale,
  type Locale,
  type Me,
  type SignupMode,
} from '@bantoozi/shared';
import { renderEmail, type EmailTemplate } from '@bantoozi/shared/server';
import type { FastifyBaseLogger } from 'fastify';

import type { ApiConfig, ApiServices } from '../context.js';
import { newSessionToken } from '../plugins/auth.js';
import { loadMe } from './me.js';

/**
 * Sign-in codes and verification (spec 08 §2.1). Thin orchestration over `@bantoozi/db`: the SQL
 * lives in `packages/db/src/api/auth.ts`.
 *
 * - A code is 6 CSPRNG digits, stored only as `HMAC-SHA256(SESSION_PEPPER, canonical(nonce, email,
 *   code))`; the plaintext lives in request memory until the email is handed to the mailer. It is
 *   never logged and never enters the outbox (spec 02 §5.1 auth-mail exception).
 * - Requests and verifications of one normalized email serialize on a transaction advisory lock
 *   plus the challenge row lock.
 * - A failed verification commits its attempt increment and only then answers `INVALID_CODE`.
 */

export const LOGIN_CODE_TTL_MINUTES = 10;
export const LOGIN_CODE_MAX_ATTEMPTS = 5;
/** `POST /auth/request-code`: 5 per hour per email (spec 08 §11); over it, still `202`, no email. */
export const REQUEST_CODE_EMAIL_LIMIT = { max: 5, windowSeconds: 3600 } as const;

/**
 * The minimum duration of a `request-code` answer, so its timing does not depend on whether the
 * account exists, which email was sent or whether the per-email throttle applied. Mutable only so
 * tests can shorten it; production keeps the default.
 */
export const authTiming = { minResponseMs: 600 };

/** Wait until `minResponseMs` have passed since `startedAt` (a `performance.now()` value). */
export async function padResponse(startedAt: number, minMs = authTiming.minResponseMs) {
  const remaining = minMs - (performance.now() - startedAt);
  if (remaining > 0) await sleep(remaining);
}

/** 6 decimal digits from a CSPRNG. */
export function newLoginCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/**
 * `HMAC-SHA256(pepper, canonical(challenge_nonce, email, code))`. The canonical encoding is a JSON
 * array of strings with a version tag, which is unambiguous for any field contents.
 */
export function loginCodeDigest(
  pepper: string,
  input: { challengeNonce: string; email: string; code: string },
): string {
  const material = JSON.stringify([
    'bantoozi:login-code:v1',
    input.challengeNonce.toLowerCase(),
    input.email,
    input.code,
  ]);
  return createHmac('sha256', pepper).update(material, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex digests. */
export function digestsEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** Rate-limit bucket of an email: a keyed hash, never the address (spec 02 §6). */
export function emailBucketKey(pepper: string, email: string): string {
  const digest = createHmac('sha256', pepper)
    .update(`bantoozi:rate-limit-email:v1:${email}`, 'utf8')
    .digest('hex');
  return `auth-request-code:email:${digest}`;
}

/**
 * The preferred supported locale of an `Accept-Language` header (highest q first, ties in header
 * order); `en` when none of `en`/`sk` is acceptable or the header is missing.
 */
export function preferredLocale(header: string | undefined): Locale {
  if (header === undefined) return 'en';
  const ranked = header
    .slice(0, 512)
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params
        .map((p) => p.trim())
        .find((p) => p.startsWith('q='))
        ?.slice(2);
      const weight = q === undefined ? 1 : Number(q);
      return { tag: tag.trim().toLowerCase(), weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((entry) => entry.weight > 0 && /^(en|sk)(?:-|$)/.test(entry.tag))
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  const best = ranked[0];
  return best === undefined ? 'en' : supportedLocale(best.tag);
}

/** `PUBLIC_BASE_URL` without a trailing slash. */
export function publicBase(config: ApiConfig): string {
  return config.publicBaseUrl.replace(/\/+$/, '');
}

/** The public waitlist page (spec 09). */
export function waitlistUrl(config: ApiConfig): string {
  return `${publicBase(config)}/waitlist`;
}

/**
 * The effective signup mode: `settings['signup_mode']` when stored, else `SIGNUP_MODE`, read on
 * every call (spec 08 §2.1). A stored value that no longer parses is reported and fails closed.
 */
export async function effectiveSignupMode(
  db: Executor,
  config: ApiConfig,
  log?: FastifyBaseLogger,
): Promise<SignupMode> {
  const stored = await readStoredSetting(db, 'signup_mode');
  try {
    return (
      readSetting('signup_mode', stored, {
        signupMode: config.signupMode,
        dailyBudgetUsd: config.dailyBudgetUsd,
        languageModes: config.languageModes,
      }) ?? config.signupMode
    );
  } catch {
    log?.error('settings.signup_mode is invalid; treating signup as closed');
    return 'closed';
  }
}

function isAdminEmail(config: ApiConfig, email: string): boolean {
  return config.adminEmails.includes(email);
}

/**
 * Send one templated email with the bounded mailer; `false` on failure, never throws. Logs only the
 * failure class, never the address, code or body (spec 08 §1 "Validation and privacy").
 */
export async function deliverEmail(
  services: Pick<ApiServices, 'mailer'>,
  to: string,
  template: EmailTemplate,
  locale: Locale,
  log?: FastifyBaseLogger,
): Promise<boolean> {
  try {
    await services.mailer.send({ to, ...renderEmail(template, locale) });
    return true;
  } catch (error) {
    const reason =
      error instanceof Error ? ((error as { code?: unknown }).code ?? error.name) : typeof error;
    log?.warn({ mail: { kind: template.kind, reason: String(reason) } }, 'email delivery failed');
    return false;
  }
}

export interface RequestCodeInput {
  /** Normalized (trimmed, lower-cased). */
  email: string;
  /** As typed; normalized here, an impossible code counts as no invite. */
  inviteCode?: string | undefined;
  /** Requested locale (already mapped to `en`/`sk`). */
  locale?: Locale | undefined;
  /** `Accept-Language`, used for the email when no locale was requested. */
  acceptLanguage?: string | undefined;
  ip: string | null;
}

/** What `request-code` decided; only for tests and logs of the kind, never sent to the client. */
export type RequestCodeOutcome = 'throttled' | 'login' | 'signup' | 'invite_only' | 'none';

/**
 * `POST /auth/request-code` (spec 08 §2.1 decision table). Commits the challenge first, then
 * attempts bounded synchronous delivery; the caller always answers `202` and pads the timing.
 */
export async function requestLoginCode(
  services: Pick<ApiServices, 'db' | 'config' | 'mailer' | 'limiter'>,
  input: RequestCodeInput,
  log?: FastifyBaseLogger,
): Promise<RequestCodeOutcome> {
  const { db, config, limiter } = services;
  const { email } = input;
  const throttle = await limiter.hit(
    emailBucketKey(config.sessionPepper, email),
    REQUEST_CODE_EMAIL_LIMIT,
  );
  if (!throttle.allowed) return 'throttled';

  const inviteCode = input.inviteCode === undefined ? null : normalizeInviteCode(input.inviteCode);
  const code = newLoginCode();
  const decision = await db.transaction(async (tx) => {
    await lockAuthEmail(tx, email);
    const issue = async (
      purpose: 'login' | 'signup',
      loginUserId: string | null,
      invite: string | null,
    ) => {
      const challengeNonce = randomUUID();
      await issueLoginCode(tx, {
        email,
        challengeNonce,
        codeHash: loginCodeDigest(config.sessionPepper, { challengeNonce, email, code }),
        purpose,
        loginUserId,
        inviteCode: invite,
        locale: input.locale ?? null,
        requestedIp: input.ip,
        ttlSeconds: LOGIN_CODE_TTL_MINUTES * 60,
      });
    };

    const user = await findUserByEmail(tx, email);
    if (user !== null) {
      await issue('login', user.id, null);
      return { kind: 'login' as const };
    }
    const mode = await effectiveSignupMode(tx, config, log);
    if (mode === 'closed') return { kind: 'none' as const };
    const validInvite =
      inviteCode !== null && (await findUsableInvite(tx, { code: inviteCode, email }));
    if (isAdminEmail(config, email) || mode === 'open' || validInvite) {
      await issue('signup', null, validInvite ? inviteCode : null);
      return { kind: 'signup' as const };
    }
    return { kind: 'invite_only' as const };
  });

  const locale = input.locale ?? preferredLocale(input.acceptLanguage);
  const expiresInMinutes = LOGIN_CODE_TTL_MINUTES;
  switch (decision.kind) {
    case 'login':
      await deliverEmail(
        services,
        email,
        { kind: 'login_code', code, expiresInMinutes },
        locale,
        log,
      );
      break;
    case 'signup':
      await deliverEmail(
        services,
        email,
        { kind: 'signup_code', code, expiresInMinutes },
        locale,
        log,
      );
      break;
    case 'invite_only':
      await deliverEmail(
        services,
        email,
        { kind: 'invite_only', waitlistUrl: waitlistUrl(config) },
        locale,
        log,
      );
      break;
    case 'none':
      break;
  }
  return decision.kind;
}

export interface VerifyInput {
  /** Normalized. */
  email: string;
  code: string;
  acceptLanguage?: string | undefined;
  userAgent: string | null;
  ip: string | null;
}

export type VerifyResult = { ok: true; me: Me; token: string; expiresAt: Date } | { ok: false };

/**
 * `POST /auth/verify` (spec 08 §2.1). One transaction: lock the email and its challenge, check the
 * digest in constant time, then atomically consume the code, create or restore the user (rechecking
 * signup eligibility and the invite under the mode in effect now), consume the invite, re-apply the
 * admin role, update `last_active_at` and create the session. Every failure returns `{ok: false}`
 * from the transaction, so the attempt counter and the consumption commit; the caller answers the
 * same generic `INVALID_CODE` for all of them.
 */
export async function verifyLoginCode(
  services: Pick<ApiServices, 'db' | 'config'>,
  input: VerifyInput,
  log?: FastifyBaseLogger,
): Promise<VerifyResult> {
  const { db, config } = services;
  const { email } = input;
  const fail = { ok: false } as const;
  return db.transaction(async (tx): Promise<VerifyResult> => {
    await lockAuthEmail(tx, email);
    const challenge = await lockActiveLoginCode(tx, email);
    if (challenge === null || challenge.expired) return fail;
    if (challenge.attempts >= LOGIN_CODE_MAX_ATTEMPTS) return fail;
    const digest = loginCodeDigest(config.sessionPepper, {
      challengeNonce: challenge.challengeNonce,
      email,
      code: input.code,
    });
    if (!digestsEqual(digest, challenge.codeHash)) {
      await recordFailedLoginAttempt(tx, {
        id: challenge.id,
        maxAttempts: LOGIN_CODE_MAX_ATTEMPTS,
      });
      return fail;
    }
    if (!(await consumeLoginCode(tx, challenge.id))) return fail;

    const admin = isAdminEmail(config, email);
    let userId: string;
    let restore = false;
    if (challenge.purpose === 'login') {
      // A purged user takes its code row with it (ON DELETE CASCADE); the checks below also refuse
      // a row that no longer matches, so a login code never turns into a signup authorization.
      if (challenge.loginUserId === null) return fail;
      const user = await lockUserForVerify(tx, challenge.loginUserId);
      if (user === null || user.email !== email || !user.restorable) return fail;
      userId = user.id;
      restore = user.deletedAt !== null;
    } else {
      if ((await findUserByEmail(tx, email)) !== null) return fail;
      const mode = await effectiveSignupMode(tx, config, log);
      const invite =
        challenge.inviteCode !== null &&
        (await findUsableInvite(tx, { code: challenge.inviteCode, email, lock: true }))
          ? challenge.inviteCode
          : null;
      const eligible = mode !== 'closed' && (admin || mode === 'open' || invite !== null);
      if (!eligible) return fail;
      userId = newUserId();
      const inserted = await insertSignupUser(tx, {
        id: userId,
        email,
        locale: challenge.locale ?? preferredLocale(input.acceptLanguage),
        role: admin ? 'admin' : 'user',
        invitesLeft: planLimits(DEFAULT_PLAN).invitesOnSignup,
      });
      // Both are impossible under the email lock and the invite row lock; never commit half a signup.
      if (!inserted) throw new Error('signup user already exists');
      if (invite !== null && !(await consumeInvite(tx, { code: invite, email, userId }))) {
        throw new Error('locked invite could not be consumed');
      }
      await deleteWaitlistEntry(tx, email);
    }

    await recordVerifiedLogin(tx, { userId, admin });
    const tenant = await bindTenant(tx, userId);
    if (restore) await restoreSoftDeletedUser(tenant);
    const { token, tokenHash } = newSessionToken();
    const session = await createSession(tx, {
      userId,
      tokenHash,
      userAgent: input.userAgent,
      ip: input.ip,
      ttlDays: config.sessionTtlDays,
    });
    const me = await loadMe(tenant);
    return { ok: true, me, token, expiresAt: session.expiresAt };
  });
}
