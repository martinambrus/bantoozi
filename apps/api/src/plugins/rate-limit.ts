import { rateLimitHit, type Database } from '@bantoozi/db';
import { AppError } from '@bantoozi/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { RateLimitRule } from '../types.js';

/**
 * Rate limits (spec 08 §11). Every bucket lives in Postgres behind `rate_limit_hit()`, so limits are
 * shared by all API processes and survive restarts. A route is subject to the global per-IP limit,
 * the per-user limit for authenticated mutations, and its own `config.rateLimits`. All of them are
 * off only when `RATE_LIMITS_ENABLED=false` (allowed with `NODE_ENV=test` only, spec 01 §3).
 *
 * The limited response carries `X-RateLimit-Limit` (the tightest applicable maximum) and, on 429,
 * `Retry-After` and `X-RateLimit-Reset` in seconds (D-120: `rate_limit_hit()` reports whether a hit
 * is allowed and when to retry, not the remaining count, so `X-RateLimit-Remaining` is not sent).
 */

/** Global per-IP limit on every route. */
export const GLOBAL_IP_LIMIT: RateLimitRule = {
  group: 'all',
  max: 300,
  windowSeconds: 60,
  per: 'ip',
};
/** Authenticated mutations, per user. */
export const USER_MUTATION_LIMIT: RateLimitRule = {
  group: 'mutation',
  max: 120,
  windowSeconds: 60,
  per: 'user',
};

export interface RateLimiter {
  readonly enabled: boolean;
  /**
   * Count one hit on `key`; `allowed:false` once the window's maximum is exceeded. Always allowed
   * while limits are disabled. Personal subjects (emails) must be hashed by the caller.
   */
  hit(
    key: string,
    rule: Pick<RateLimitRule, 'max' | 'windowSeconds'>,
  ): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
}

export function createRateLimiter(db: Database, enabled: boolean): RateLimiter {
  return {
    enabled,
    async hit(key, rule) {
      if (!enabled) return { allowed: true, retryAfterSeconds: 0 };
      return rateLimitHit(db, { key, windowSeconds: rule.windowSeconds, max: rule.max });
    },
  };
}

/** Throw `429 RATE_LIMITED` with `Retry-After`; used by the hooks and by handlers with own keys. */
export function rateLimited(reply: FastifyReply, retryAfterSeconds: number): AppError {
  const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
  void reply.header('retry-after', String(seconds)).header('x-ratelimit-reset', String(seconds));
  return new AppError('RATE_LIMITED', 'Too many requests', {
    details: { retryAfter: seconds },
  });
}

async function apply(
  limiter: RateLimiter,
  request: FastifyRequest,
  reply: FastifyReply,
  rules: readonly RateLimitRule[],
): Promise<void> {
  if (!limiter.enabled || rules.length === 0) return;
  let tightest = Number.POSITIVE_INFINITY;
  for (const rule of rules) {
    const subject = rule.per === 'ip' ? request.ip : request.auth?.userId;
    if (subject === undefined) continue;
    tightest = Math.min(tightest, rule.max);
    const result = await limiter.hit(`${rule.group}:${rule.per}:${subject}`, rule);
    if (!result.allowed) {
      void reply.header('x-ratelimit-limit', String(rule.max));
      throw rateLimited(reply, result.retryAfterSeconds);
    }
  }
  if (Number.isFinite(tightest)) void reply.header('x-ratelimit-limit', String(tightest));
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Installs the limits as hooks on the root instance: the per-IP limit before authentication, the
 * per-user and route limits after it (they need the user id).
 */
export function registerRateLimits(app: FastifyInstance, limiter: RateLimiter): void {
  app.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions.config.healthProbe !== true) {
      await apply(limiter, request, reply, [GLOBAL_IP_LIMIT]);
      return;
    }
    // Health probes stay limited, but must still answer while the limiter's database is down.
    try {
      await apply(limiter, request, reply, [GLOBAL_IP_LIMIT]);
    } catch (error) {
      if (error instanceof AppError) throw error;
      request.log.warn({ err: error }, 'rate limit unavailable for a health probe');
    }
  });
  app.addHook('preValidation', async (request, reply) => {
    const config = request.routeOptions.config;
    const rules: RateLimitRule[] = [];
    const mutation =
      request.auth !== null &&
      MUTATING.has(request.method) &&
      config.authFlow !== true &&
      !request.metricsBearer;
    if (mutation) rules.push(USER_MUTATION_LIMIT);
    rules.push(...(config.rateLimits ?? []));
    if (rules.length === 0 || !limiter.enabled) return;
    // A retry of a committed (or in-flight) mutation replays its receipt: it is not charged again.
    if (mutation && (await request.knownKey())) return;
    await apply(limiter, request, reply, rules);
  });
}
