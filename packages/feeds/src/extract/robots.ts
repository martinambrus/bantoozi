import { createRequire } from 'node:module';

import { DEFAULT_COOLDOWN_MS, type SafeFetchResult } from '../http/index.js';

/** The product token our crawler matches in robots.txt `User-agent` lines (spec 03 §8.1 step 2). */
export const ROBOTS_PRODUCT_TOKEN = 'BantooziBot';

/** Origins kept in the robots.txt cache (spec 03 §8.1 step 2). */
export const ROBOTS_CACHE_MAX_ORIGINS = 5000;

/** Fresh lifetime of a robots.txt answer (spec 03 §8.1 step 2, RFC 9309 §2.4). */
export const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;

/** How long a temporary failure (unreachable robots.txt) is cached (spec 03 §8.1 step 2). */
export const ROBOTS_FAILURE_TTL_MS = 5 * 60 * 1000;

/** The outcome of a robots.txt check for one URL. */
export interface RobotsDecision {
  allowed: boolean;
  /**
   * `allowed`/`disallowed` come from the rules (or an allow-all/disallow-all status);
   * `unreachable` means robots.txt could not be read and no usable cached rules exist, so this
   * attempt is disallowed; `cooldown` means the origin is cooling down until `retryAt`.
   */
  reason: 'allowed' | 'disallowed' | 'unreachable' | 'cooldown';
  retryAt?: Date;
}

export interface RobotsChecker {
  /**
   * Decides whether {@link ROBOTS_PRODUCT_TOKEN} may fetch `url`. Rejects only when the injected
   * fetch rejects: an infrastructure failure, which is never cached.
   */
  check(url: URL): Promise<RobotsDecision>;
}

/** Fetches `/robots.txt`: the worker binds `safeFetch` with purpose `robots` and no robots policy. */
export type RobotsFetch = (url: string, purpose: 'robots') => Promise<SafeFetchResult>;

export interface RobotsCheckerOptions {
  fetch: RobotsFetch;
  /** Clock in epoch ms; defaults to `Date.now`. */
  now?: () => number;
  /** LRU bound; defaults to {@link ROBOTS_CACHE_MAX_ORIGINS}. */
  maxOrigins?: number;
  /** Fresh lifetime of rules and of allow-all/disallow-all answers; defaults to 24 h. */
  ttlMs?: number;
  /** Lifetime of a cached unreachable failure; defaults to 5 minutes. */
  failureTtlMs?: number;
  /**
   * How long after its fresh lifetime a rule set stays usable while robots.txt is unreachable
   * (RFC 9309 §2.4 allows a cached copy past 24 h in that case); defaults to `ttlMs`.
   */
  maxStaleMs?: number;
}

/** The subset of the `robots-parser` API used here. */
interface RobotsRules {
  isAllowed(url: string, userAgent?: string): boolean | undefined;
}

type RobotsParser = (url: string, contents: string) => RobotsRules;

// `robots-parser` is CommonJS whose typings declare an ES default export that Node does not
// provide; load `module.exports` directly.
const robotsParser = createRequire(import.meta.url)('robots-parser') as RobotsParser;

/** A definitive robots.txt answer. */
type RobotsPolicy =
  { kind: 'rules'; rules: RobotsRules } | { kind: 'allow_all' } | { kind: 'disallow_all' };

interface RobotsEntry {
  /** Last definitive answer: fresh until `freshUntil`, usable while unreachable until `usableUntil`. */
  policy: { value: RobotsPolicy; freshUntil: number; usableUntil: number } | null;
  /** A temporary failure that suppresses refetching until `until`. */
  failure: { reason: 'unreachable' | 'cooldown'; until: number } | null;
}

/**
 * The robots.txt policy of spec 03 §8.1 step 2, following RFC 9309 §2.3–2.4:
 * - one `/robots.txt` per origin (scheme, host and port), fetched through the injected fetch with
 *   purpose `robots` (never itself robots-checked), parsed with `robots-parser` against the product
 *   token {@link ROBOTS_PRODUCT_TOKEN}; the rules of a redirected robots.txt apply to the origin
 *   that was asked;
 * - an in-memory LRU of `maxOrigins` origins; answers stay fresh for `ttlMs` (24 h);
 * - 2xx: the parsed rules; 404, 410 and other unavailable 4xx: allow all; 401/403: disallow all
 *   (conservative); more than the allowed redirects: unavailable, so allow all (RFC 9309 §2.3.1.2);
 *   a robots.txt beyond the fetch size cap: disallow all;
 * - 429, or any failure that carries a `retryAt` (a 503 with `Retry-After`, an origin cooldown):
 *   `cooldown` until then, without refetching before it ends;
 * - network, DNS, TLS and timeout failures and 5xx are **unreachable**, never allow-all: an
 *   unexpired cached rule set (fresh, or stale by at most `maxStaleMs`) keeps deciding, otherwise
 *   this attempt is disallowed; the failure is cached for `failureTtlMs` (5 minutes), not 24 h;
 * - a rejected fetch is no answer from the origin but an infrastructure failure (for example, the
 *   PostgreSQL origin limiter is unavailable): the check rejects with it and nothing is cached, so
 *   the caller's job retries with a fresh request instead of a cached `unreachable`.
 *
 * Concurrent checks of one origin share a single robots.txt request, and its rejection.
 */
export function createRobotsChecker(options: RobotsCheckerOptions): RobotsChecker {
  const now = options.now ?? Date.now;
  const maxOrigins = Math.max(1, options.maxOrigins ?? ROBOTS_CACHE_MAX_ORIGINS);
  const ttlMs = options.ttlMs ?? ROBOTS_TTL_MS;
  const failureTtlMs = options.failureTtlMs ?? ROBOTS_FAILURE_TTL_MS;
  const maxStaleMs = options.maxStaleMs ?? ttlMs;
  const cache = new Map<string, RobotsEntry>();
  const inFlight = new Map<string, Promise<RobotsEntry>>();

  const remember = (origin: string, entry: RobotsEntry): void => {
    cache.delete(origin);
    cache.set(origin, entry);
    while (cache.size > maxOrigins) {
      const oldest = cache.keys().next();
      if (oldest.done === true) break;
      cache.delete(oldest.value);
    }
  };

  /** The cached entry if it can answer without a request; refreshes its LRU position. */
  const cached = (origin: string, at: number): RobotsEntry | undefined => {
    const entry = cache.get(origin);
    if (entry === undefined) return undefined;
    const failureActive = entry.failure !== null && entry.failure.until > at;
    const policyFresh = entry.policy !== null && entry.policy.freshUntil > at;
    if (!failureActive && !policyFresh) return undefined;
    cache.delete(origin);
    cache.set(origin, entry);
    return entry;
  };

  const refresh = async (origin: string): Promise<RobotsEntry> => {
    const robotsUrl = `${origin}/robots.txt`;
    const previous = cache.get(origin) ?? null;
    // A rejection propagates before anything is cached (see above).
    const result = await options.fetch(robotsUrl, 'robots');
    const at = now();
    let outcome: FetchOutcome;
    try {
      outcome = classify(result, robotsUrl);
    } catch {
      outcome = { kind: 'unreachable' };
    }
    let entry: RobotsEntry;
    if (outcome.kind === 'policy') {
      entry = {
        policy: {
          value: outcome.policy,
          freshUntil: at + ttlMs,
          usableUntil: at + ttlMs + maxStaleMs,
        },
        failure: null,
      };
    } else if (outcome.kind === 'cooldown') {
      // A 429 without `Retry-After` (or a past one) still cools down for at least 60 s (§8.2).
      const until = outcome.retryAt?.getTime() ?? at + DEFAULT_COOLDOWN_MS;
      entry = {
        policy: previous?.policy ?? null,
        failure: { reason: 'cooldown', until: until > at ? until : at + DEFAULT_COOLDOWN_MS },
      };
    } else {
      entry = {
        policy: previous?.policy ?? null,
        failure: { reason: 'unreachable', until: at + failureTtlMs },
      };
    }
    remember(origin, entry);
    return entry;
  };

  return {
    async check(url) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { allowed: false, reason: 'disallowed' };
      }
      const origin = url.origin;
      let entry = cached(origin, now());
      if (entry === undefined) {
        let pending = inFlight.get(origin);
        if (pending === undefined) {
          pending = refresh(origin).finally(() => inFlight.delete(origin));
          inFlight.set(origin, pending);
        }
        entry = await pending;
      }
      return decide(entry, url, now());
    },
  };
}

type FetchOutcome =
  | { kind: 'policy'; policy: RobotsPolicy }
  | { kind: 'cooldown'; retryAt: Date | undefined }
  | { kind: 'unreachable' };

/** Maps a robots.txt fetch result to a policy or a temporary failure (RFC 9309 §2.3.1). */
function classify(result: SafeFetchResult, robotsUrl: string): FetchOutcome {
  if (result.ok) {
    if (result.status < 200 || result.status > 299) {
      return { kind: 'policy', policy: { kind: 'allow_all' } };
    }
    const text = new TextDecoder('utf-8').decode(result.bodyBytes);
    return { kind: 'policy', policy: { kind: 'rules', rules: robotsParser(robotsUrl, text) } };
  }
  if (result.retryAt !== undefined || result.code === 'FEED_ORIGIN_COOLDOWN') {
    return { kind: 'cooldown', retryAt: result.retryAt };
  }
  const status = result.status ?? httpStatusOf(result.code);
  if (status !== undefined) {
    if (status === 429) return { kind: 'cooldown', retryAt: undefined };
    if (status === 401 || status === 403) {
      return { kind: 'policy', policy: { kind: 'disallow_all' } };
    }
    if (status >= 400 && status <= 499) return { kind: 'policy', policy: { kind: 'allow_all' } };
    return { kind: 'unreachable' };
  }
  if (result.code === 'FEED_TOO_MANY_REDIRECTS') {
    return { kind: 'policy', policy: { kind: 'allow_all' } };
  }
  if (result.code === 'FEED_TOO_LARGE') return { kind: 'policy', policy: { kind: 'disallow_all' } };
  return { kind: 'unreachable' };
}

function httpStatusOf(code: string): number | undefined {
  const match = /^FEED_HTTP_(\d{3})$/.exec(code);
  return match === null ? undefined : Number(match[1]);
}

function decide(entry: RobotsEntry, url: URL, at: number): RobotsDecision {
  const failure = entry.failure !== null && entry.failure.until > at ? entry.failure : null;
  if (failure?.reason === 'cooldown') {
    return { allowed: false, reason: 'cooldown', retryAt: new Date(failure.until) };
  }
  const policy = entry.policy;
  const usable =
    policy !== null && (failure === null ? policy.freshUntil > at : policy.usableUntil > at);
  if (!usable) return { allowed: false, reason: 'unreachable' };
  return applyPolicy(policy.value, url);
}

function applyPolicy(policy: RobotsPolicy, url: URL): RobotsDecision {
  if (policy.kind === 'allow_all') return { allowed: true, reason: 'allowed' };
  if (policy.kind === 'disallow_all') return { allowed: false, reason: 'disallowed' };
  // `undefined` (URL outside this robots.txt's origin) cannot happen for a same-origin key; it
  // fails closed.
  return policy.rules.isAllowed(url.href, ROBOTS_PRODUCT_TOKEN) === true
    ? { allowed: true, reason: 'allowed' }
    : { allowed: false, reason: 'disallowed' };
}
