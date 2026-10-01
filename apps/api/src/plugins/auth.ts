import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { resolveSession, slideSession } from '@bantoozi/db';
import { AppError } from '@bantoozi/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ApiConfig } from '../context.js';
import type { AuthMode } from '../types.js';

/**
 * Session authentication (spec 08 §1 "Authorization", §2.1 "Session cookie"). The cookie holds 32
 * random bytes (base64url); the database stores only their SHA-256. Every request re-reads the
 * session and the user's current role, rejects expired/revoked sessions and deleted users, and
 * slides the session (and `users.last_active_at`) at most every 5 minutes, re-issuing the cookie
 * with a matching Max-Age.
 */

/** A new session token and the hash stored in `sessions.token_hash`. */
export function newSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: sessionTokenHash(token) };
}

export function sessionTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The value of one cookie from a `Cookie` header, without a cookie library. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** `Set-Cookie` for the session: HttpOnly, SameSite=Lax, Path=/, Secure in production. */
export function sessionCookie(config: ApiConfig, token: string, maxAgeSeconds: number): string {
  const attributes = [
    `${config.sessionCookieName}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (config.nodeEnv === 'production') attributes.push('Secure');
  return attributes.join('; ');
}

/** Clears the cookie with the same Path/attributes it was set with (spec 08 §2.1). */
export function clearSessionCookie(config: ApiConfig): string {
  return sessionCookie(config, '', 0);
}

export function setSessionCookie(
  reply: FastifyReply,
  config: ApiConfig,
  token: string,
  expiresAt: Date,
  now: Date,
): void {
  const maxAge = Math.round((expiresAt.getTime() - now.getTime()) / 1000);
  void reply.header('set-cookie', sessionCookie(config, token, maxAge));
}

/** Constant-time comparison of the `Authorization: Bearer` value with `METRICS_TOKEN`. */
export function isMetricsBearer(
  request: FastifyRequest,
  metricsToken: string | undefined,
): boolean {
  if (metricsToken === undefined || metricsToken.length === 0) return false;
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = createHash('sha256').update(header.slice(7), 'utf8').digest();
  const expected = createHash('sha256').update(metricsToken, 'utf8').digest();
  return timingSafeEqual(supplied, expected);
}

const unauthenticated = () => new AppError('UNAUTHENTICATED', 'Sign in required');
const forbidden = () => new AppError('FORBIDDEN', 'Not allowed');

/** The route's declared auth mode; undeclared routes fail closed as `user`. */
export function routeAuthMode(request: FastifyRequest): AuthMode {
  return request.routeOptions.config.auth ?? 'user';
}

export function registerAuth(app: FastifyInstance): void {
  app.decorateRequest('auth', null);
  app.decorateRequest('metricsBearer', false);

  app.addHook('onRequest', async (request, reply) => {
    const { db, config, clock } = app.services;
    const mode = routeAuthMode(request);
    // Unknown routes answer 404 without revealing whether a session would have helped.
    if (mode === 'public' || request.is404) return;

    if (mode === 'metrics' || mode === 'admin_or_metrics') {
      if (isMetricsBearer(request, config.metricsToken)) {
        request.metricsBearer = true;
        return;
      }
      if (mode === 'metrics') throw unauthenticated();
    }

    const token = readCookie(request.headers.cookie, config.sessionCookieName);
    if (token === undefined || !TOKEN_PATTERN.test(token)) throw unauthenticated();
    const session = await resolveSession(db, sessionTokenHash(token));
    if (session === null) throw unauthenticated();
    request.auth = { ...session, token };

    if (mode === 'admin' || mode === 'admin_or_metrics') {
      if (session.role !== 'admin') throw forbidden();
    }

    const expiresAt = await slideSession(db, {
      sessionId: session.sessionId,
      ttlDays: config.sessionTtlDays,
    });
    if (expiresAt !== null) setSessionCookie(reply, config, token, expiresAt, clock.now());
  });
}
