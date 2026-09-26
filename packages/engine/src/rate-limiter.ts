import { waiterOrderKey, DEFAULT_AGING_MS } from './semaphore.js';
import type { Priority } from './types.js';

/**
 * Client-side rate limiter for one TypeSafe API account (spec 04 §3): two token buckets, requests
 * per minute and input tokens per second. The account limits are shared by every process of the
 * deployment, so each process gets a static `share` (the shares must sum to at most 1; API
 * translation does not use these buckets). The token cost of an attempt is its conservative
 * estimate (spec 04 §6.1), taken before the attempt. A 429 lowers the capacity temporarily and
 * honours the server's delay for every waiter of this process. Waiting is bounded by the job
 * deadline, cancellable, and ordered interactive before bulk with aging (as the semaphore).
 */

/** Published-limit-based defaults (spec 04 §3); configurable, not a guarantee. */
export const TYPESAFE_REQUESTS_PER_MINUTE = 1_000;
export const TYPESAFE_INPUT_TOKENS_PER_SECOND = 200_000;
/** Capacity multiplier while a 429 penalty is active. */
export const RATE_LIMIT_PENALTY_FACTOR = 0.5;
/** Minimum duration of a 429 penalty. */
export const RATE_LIMIT_PENALTY_MS = 60_000;

export interface RateLimiterOptions {
  requestsPerMinute?: number;
  inputTokensPerSecond?: number;
  /** This process's share of the account limits, in (0, 1]. */
  share?: number;
  penaltyFactor?: number;
  penaltyMs?: number;
  agingMs?: number;
  /** Clock (epoch ms); waits use `setTimeout`, so fake timers drive both. */
  now?: () => number;
}

export type RateLimitAcquisition =
  | { ok: true }
  /** `retryAt`: when capacity is expected (deadline) or now (cancelled). */
  | { ok: false; reason: 'cancelled' | 'deadline'; retryAt: Date };

export interface RateLimitRequest {
  /** Estimated input tokens of the attempt. */
  tokens: number;
  priority: Priority;
  signal?: AbortSignal;
  /** Absolute deadline (epoch ms). */
  deadlineMs?: number;
}

export interface RateLimiter {
  acquire(request: RateLimitRequest): Promise<RateLimitAcquisition>;
  /** A 429 from the provider: lower capacity temporarily and wait at least `retryAfterMs`. */
  penalize(retryAfterMs?: number): void;
  /** Current bucket levels and limits (diagnostics and tests). */
  snapshot(): {
    requests: number;
    tokens: number;
    requestCapacity: number;
    tokenCapacity: number;
    penalized: boolean;
    blockedUntil: number;
    waiting: number;
  };
}

interface Waiter {
  key: number;
  seq: number;
  tokens: number;
  deadlineMs: number | undefined;
  settle: (result: RateLimitAcquisition) => void;
}

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
}

export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const share = options.share ?? 1;
  if (!Number.isFinite(share) || share <= 0 || share > 1) {
    throw new RangeError('share must be in (0, 1]');
  }
  const requestCapacity =
    positive('requestsPerMinute', options.requestsPerMinute ?? TYPESAFE_REQUESTS_PER_MINUTE) *
    share;
  const tokenCapacity =
    positive(
      'inputTokensPerSecond',
      options.inputTokensPerSecond ?? TYPESAFE_INPUT_TOKENS_PER_SECOND,
    ) * share;
  const penaltyFactor = options.penaltyFactor ?? RATE_LIMIT_PENALTY_FACTOR;
  if (!(penaltyFactor > 0 && penaltyFactor <= 1)) {
    throw new RangeError('penaltyFactor must be in (0, 1]');
  }
  const penaltyMs = options.penaltyMs ?? RATE_LIMIT_PENALTY_MS;
  const agingMs = options.agingMs ?? DEFAULT_AGING_MS;
  const now = options.now ?? Date.now;

  let requests = requestCapacity;
  let tokens = tokenCapacity;
  let lastRefill = now();
  let penaltyUntil = Number.NEGATIVE_INFINITY;
  let blockedUntil = Number.NEGATIVE_INFINITY;
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const queue: Waiter[] = [];

  const factor = (t: number) => (t < penaltyUntil ? penaltyFactor : 1);
  const caps = (t: number) => ({
    requests: requestCapacity * factor(t),
    tokens: tokenCapacity * factor(t),
  });

  function refill(t: number): void {
    const elapsed = Math.max(0, t - lastRefill);
    lastRefill = Math.max(lastRefill, t);
    const cap = caps(t);
    requests = Math.min(cap.requests, requests + (elapsed * cap.requests) / 60_000);
    tokens = Math.min(cap.tokens, tokens + (elapsed * cap.tokens) / 1_000);
  }

  /** Earliest time (≥ t) at which a request of `need` tokens fits, at the current rates. */
  function readyAt(need: number, t: number): number {
    const cap = caps(t);
    const needTokens = Math.min(need, cap.tokens);
    const waitRequests = requests >= 1 ? 0 : ((1 - requests) * 60_000) / cap.requests;
    const waitTokens = tokens >= needTokens ? 0 : ((needTokens - tokens) * 1_000) / cap.tokens;
    return Math.max(t + waitRequests, t + waitTokens, blockedUntil);
  }

  function consume(need: number): void {
    requests -= 1;
    // A request above one bucket's capacity waits for a full bucket and leaves a debt behind.
    tokens -= need;
  }

  function head(): Waiter | undefined {
    let best: Waiter | undefined;
    for (const w of queue) {
      if (best === undefined || w.key < best.key || (w.key === best.key && w.seq < best.seq)) {
        best = w;
      }
    }
    return best;
  }

  function remove(waiter: Waiter): boolean {
    const index = queue.indexOf(waiter);
    if (index < 0) return false;
    queue.splice(index, 1);
    return true;
  }

  function schedule(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    for (;;) {
      const next = head();
      if (next === undefined) return;
      const t = now();
      refill(t);
      const ready = readyAt(next.tokens, t);
      if (next.deadlineMs !== undefined && ready > next.deadlineMs) {
        remove(next);
        next.settle({ ok: false, reason: 'deadline', retryAt: new Date(Math.ceil(ready)) });
        continue;
      }
      if (ready <= t) {
        remove(next);
        consume(next.tokens);
        next.settle({ ok: true });
        continue;
      }
      timer = setTimeout(schedule, Math.max(1, Math.ceil(ready - t)));
      return;
    }
  }

  return {
    acquire(request) {
      const need = request.tokens;
      if (!Number.isFinite(need) || need < 0) {
        return Promise.reject(new RangeError('tokens must be a finite non-negative number'));
      }
      const t = now();
      if (request.signal?.aborted === true) {
        return Promise.resolve({ ok: false, reason: 'cancelled', retryAt: new Date(t) });
      }
      refill(t);
      if (queue.length === 0 && readyAt(need, t) <= t) {
        consume(need);
        return Promise.resolve({ ok: true });
      }
      return new Promise<RateLimitAcquisition>((resolve) => {
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        const waiter: Waiter = {
          key: waiterOrderKey(request.priority, t, agingMs),
          seq: (seq += 1),
          tokens: need,
          deadlineMs: request.deadlineMs,
          settle: (result) => {
            if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
            request.signal?.removeEventListener('abort', onAbort);
            resolve(result);
          },
        };
        const onAbort = () => {
          if (remove(waiter)) {
            waiter.settle({ ok: false, reason: 'cancelled', retryAt: new Date(now()) });
            schedule();
          }
        };
        request.signal?.addEventListener('abort', onAbort, { once: true });
        if (request.deadlineMs !== undefined) {
          const deadline = request.deadlineMs;
          deadlineTimer = setTimeout(
            () => {
              if (!remove(waiter)) return;
              const at = now();
              refill(at);
              waiter.settle({
                ok: false,
                reason: 'deadline',
                retryAt: new Date(Math.ceil(Math.max(readyAt(need, at), at))),
              });
              schedule();
            },
            Math.max(0, deadline - t),
          );
        }
        queue.push(waiter);
        schedule();
      });
    },

    penalize(retryAfterMs) {
      const t = now();
      refill(t);
      const delay =
        retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0
          ? retryAfterMs
          : 0;
      penaltyUntil = Math.max(penaltyUntil, t + Math.max(penaltyMs, delay));
      if (delay > 0) blockedUntil = Math.max(blockedUntil, t + delay);
      const cap = caps(t);
      requests = Math.min(requests, cap.requests, 0);
      tokens = Math.min(tokens, cap.tokens);
      schedule();
    },

    snapshot() {
      const t = now();
      refill(t);
      const cap = caps(t);
      return {
        requests,
        tokens,
        requestCapacity: cap.requests,
        tokenCapacity: cap.tokens,
        penalized: t < penaltyUntil,
        blockedUntil,
        waiting: queue.length,
      };
    },
  };
}
