import { rateLimitHit, type Database } from '@bantoozi/db';
import { AppError } from '@bantoozi/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { RateLimitRule } from '../types.js';

/**
 * Rate limits (spec 08 §11). Every bucket lives in Postgres behind `rate_limit_hit()`, so limits are
 * shared by all API processes and survive restarts. A route is subject to the global per-IP limit,
 * the per-user limit for authenticated mutations, and its own `config.rateLimits`. All of them follow
 * `api.rate_limits_enabled` (else `RATE_LIMITS_ENABLED`); in production `false` keeps only the always-on
 * groups (M8b-T3).
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

/**
 * Groups that stay limited in production even when `api.rate_limits_enabled` is false (M8b-T3):
 * the unauthenticated entry points that can be abused for mail, guessing or token redemption.
 */
export const ALWAYS_ON_GROUPS: ReadonlySet<string> = new Set([
  'auth-request-code',
  'auth-verify',
  'waitlist',
  'setup-complete',
  'ops-event',
]);

/** `on`: every limit; `strict`: only the always-on groups; `off`: none. */
export type RateLimitMode = 'on' | 'strict' | 'off';

export interface RateLimiter {
  /** The mode now in force (the stored `api.rate_limits_enabled`, else the environment value). */
  mode(): Promise<RateLimitMode>;
  /**
   * Count one hit on `key`; `allowed:false` once the window's maximum is exceeded. Always allowed
   * while limits are disabled. Personal subjects (emails) must be hashed by the caller.
   */
  hit(
    key: string,
    rule: Pick<RateLimitRule, 'max' | 'windowSeconds'>,
  ): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
}

export function createRateLimiter(
  db: Database,
  enabled: () => Promise<boolean>,
  production: boolean,
): RateLimiter {
  const mode = async (): Promise<RateLimitMode> => {
    if (await enabled()) return 'on';
    return production ? 'strict' : 'off';
  };
  return {
    mode,
    async hit(key, rule) {
      const current = await mode();
      const group = key.split(':', 1)[0] ?? '';
      if (current === 'off' || (current === 'strict' && !ALWAYS_ON_GROUPS.has(group))) {
        return { allowed: true, retryAfterSeconds: 0 };
      }
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
  if (rules.length === 0 || (await limiter.mode()) === 'off') return;
  // Every response, a 429 included, reports the tightest maximum that applies to the route.
  void reply.header('x-ratelimit-limit', String(tightestLimit(request)));
  for (const rule of rules) {
    const subject = rule.per === 'ip' ? request.ip : request.auth?.userId;
    if (subject === undefined) continue;
    const result = await limiter.hit(`${rule.group}:${rule.per}:${subject}`, rule);
    if (!result.allowed) throw rateLimited(reply, result.retryAfterSeconds);
  }
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Whether the route takes a session, so its per-user limits apply to a caller. */
function sessionRoute(request: FastifyRequest): boolean {
  const auth = request.routeOptions.config.auth ?? 'user';
  return auth === 'user' || auth === 'admin' || auth === 'admin_or_metrics';
}

/**
 * The smallest maximum among the limits the route applies, known from its config before
 * authentication: the global per-IP limit, the per-user mutation limit of a session mutation and the
 * route's own limits (per-user ones only on session routes).
 */
function tightestLimit(request: FastifyRequest): number {
  const config = request.routeOptions.config;
  const session = sessionRoute(request);
  let tightest = GLOBAL_IP_LIMIT.max;
  if (session && MUTATING.has(request.method) && config.authFlow !== true) {
    tightest = Math.min(tightest, USER_MUTATION_LIMIT.max);
  }
  for (const rule of config.rateLimits ?? []) {
    if (rule.per === 'ip' || session) tightest = Math.min(tightest, rule.max);
  }
  return tightest;
}

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
    if (rules.length === 0 || (await limiter.mode()) === 'off') return;
    // A retry of a committed (or in-flight) mutation replays its receipt: it is not charged again.
    if (mutation && (await request.knownKey())) return;
    await apply(limiter, request, reply, rules);
  });
}
