import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Rater link tokens and session cookies (spec 10 §2.4): 256-bit random values, base64url, of which
 * only the SHA-256 hash is stored. The CSRF token of a session is an HMAC of its cookie value, so it
 * needs no storage and is unknowable without the HttpOnly cookie.
 */

/** Link tokens expire after this many days unless `--token-days` says otherwise. */
export const DEFAULT_TOKEN_DAYS = 30;
/** A session never outlives its token, and lasts at most this long (spec 10 §2.4). */
export const SESSION_MAX_DAYS = 30;

const DAY_MS = 86_400_000;

export function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** Hex SHA-256 of a token or cookie value (the stored form). */
export function hashSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** A link token and its expiry `days` after `now`. */
export function issueToken(
  now: Date,
  days: number = DEFAULT_TOKEN_DAYS,
): { token: string; tokenHash: string; expiresAt: Date } {
  const token = newSecret();
  return {
    token,
    tokenHash: hashSecret(token),
    expiresAt: new Date(now.getTime() + days * DAY_MS),
  };
}

/** `${EVAL_PUBLIC_URL}/r?t=<token>` (spec 10 §2.2), or `/facets?t=` for the labelling page. */
export function raterUrl(publicUrl: string, token: string, page: 'r' | 'facets' = 'r'): string {
  const base = publicUrl.replace(/\/+$/u, '');
  return `${base}/${page}?t=${encodeURIComponent(token)}`;
}

/** Plausible token shape (43 base64url characters); anything else is rejected before hashing. */
export function isTokenShaped(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/u.test(value);
}

export function csrfToken(sessionValue: string): string {
  return createHmac('sha256', sessionValue).update('bantoozi-eval-csrf').digest('base64url');
}

export function csrfMatches(sessionValue: string, candidate: unknown): boolean {
  if (typeof candidate !== 'string') return false;
  const expected = Buffer.from(csrfToken(sessionValue));
  const given = Buffer.from(candidate);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function sessionExpiry(now: Date): Date {
  return new Date(now.getTime() + SESSION_MAX_DAYS * DAY_MS);
}
