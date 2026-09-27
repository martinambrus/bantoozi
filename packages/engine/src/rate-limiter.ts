import { waiterOrderKey, DEFAULT_AGING_MS } from './semaphore.js';
import type { Priority } from './types.js';

/**
 * Client-side rate limiter for one TypeSafe API account (spec 04 §3): two token buckets, requests
 * per minute and input tokens per second. The account limits are shared by every process of the
 * deployment, so each process gets a static `share` (the shares must sum to at most 1; API
 * translation does not use these buckets). The token cost of an attempt is its conservative
 * estimate (spec 04 §6.1), taken before the attempt; an acquisition whose attempt is never sent
 * gives its debit back (`refund`). A 429 lowers the capacity temporarily and honours the server's
 * delay for every waiter of this process. Waiting is bounded by the job deadline, cancellable, and
 * ordered interactive before bulk with aging (as the semaphore).
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
  /**
   * `refund`: give the debit back when the attempt is not sent after all (a later wait expired, a
   * reservation was refused), up to the current capacities; only the first call counts, and none
   * after a 429 penalty newer than the debit.
   */
  | { ok: true; refund: () => void }
  /** `retryAt`: when capacity is expected (deadline) or now (cancelled). */
  | { ok: false; reason: 'cancelled' | 'deadline'; retryAt: Date };

export interface RateLimitRequest {
  /** Estimated input tokens of the attempt. */
  tokens: number;
  priority: Priority;
  signal?: AbortSignal;
  /** Absolute deadline (epoch ms); one already reached is refused at once, spending nothing. */
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

interface Levels {
  requests: number;
  tokens: number;
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
  /** Penalties applied so far: a refund never crosses a penalty newer than its debit. */
  let penalties = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const queue: Waiter[] = [];

  const factor = (t: number) => (t < penaltyUntil ? penaltyFactor : 1);
  const caps = (t: number) => ({
    requests: requestCapacity * factor(t),
    tokens: tokenCapacity * factor(t),
  });

  /** `level` after `elapsed` ms of refill at the rates (and up to the capacities) scaled by `f`. */
  function grown(level: Levels, elapsed: number, f: number): Levels {
    const capRequests = requestCapacity * f;
    const capTokens = tokenCapacity * f;
    return {
      requests: Math.min(capRequests, level.requests + (elapsed * capRequests) / 60_000),
      tokens: Math.min(capTokens, level.tokens + (elapsed * capTokens) / 1_000),
    };
  }

  /** Refill `elapsed` ms at the rates (and up to the capacities) scaled by `f`. */
  function accrue(elapsed: number, f: number): void {
    ({ requests, tokens } = grown({ requests, tokens }, elapsed, f));
  }

  function refill(t: number): void {
    const from = lastRefill;
    lastRefill = Math.max(lastRefill, t);
    if (from < penaltyUntil && penaltyUntil <= t) {
      // A penalty ended inside the interval: its part refills at the penalized rate, so the bucket
      // leaves the penalty no fuller than the penalized capacity instead of bursting at full.
      accrue(penaltyUntil - from, penaltyFactor);
      accrue(t - penaltyUntil, 1);
      return;
    }
    accrue(Math.max(0, t - from), factor(t));
  }

  /** How long `level`, refilling at the rates scaled by `f`, takes to fit `need` tokens. */
  function waitFor(level: Levels, need: number, f: number): number {
    const capRequests = requestCapacity * f;
    const capTokens = tokenCapacity * f;
    // A request bucket below one request (a small share, or a 429 penalty) waits for a full bucket.
    const needRequests = Math.min(1, capRequests);
    const needTokens = Math.min(need, capTokens);
    const waitRequests =
      level.requests >= needRequests ? 0 : ((needRequests - level.requests) * 60_000) / capRequests;
    const waitTokens =
      level.tokens >= needTokens ? 0 : ((needTokens - level.tokens) * 1_000) / capTokens;
    return Math.max(waitRequests, waitTokens);
  }

  /**
   * Earliest time (≥ t) at which a request of `need` tokens fits. A penalty's rates and capacities
   * hold only until it ends: a wait that runs past its end continues from the levels it leaves (as
   * `refill` accrues them) at the full rates, toward the need of the full capacities.
   */
  function readyAt(need: number, t: number): number {
    const start = Math.max(t, blockedUntil);
    const level = { requests, tokens };
    if (t < penaltyUntil) {
      const during = Math.max(start, t + waitFor(level, need, penaltyFactor));
      if (during < penaltyUntil) return during;
      const left = grown(level, penaltyUntil - t, penaltyFactor);
      return Math.max(start, penaltyUntil + waitFor(left, need, 1));
    }
    return Math.max(start, t + waitFor(level, need, 1));
  }

  /** Debit one request of `need` tokens; the acquisition's `refund` gives it back once. */
  function consume(need: number): Extract<RateLimitAcquisition, { ok: true }> {
    // A request above one bucket's capacity waits for a full bucket and leaves a debt behind, so
    // the refill rate stays the long-run limit.
    requests -= 1;
    tokens -= need;
    const generation = penalties;
    let refunded = false;
    return {
      ok: true,
      refund: () => {
        if (refunded) return;
        refunded = true;
        // A 429 since the debit emptied the request bucket on purpose: giving capacity back now
        // would let waiters that give up undo the penalty one by one.
        if (penalties !== generation) return;
        const t = now();
        refill(t);
        const cap = caps(t);
        requests = Math.min(cap.requests, requests + 1);
        tokens = Math.min(cap.tokens, tokens + need);
        schedule();
      },
    };
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
        next.settle(consume(next.tokens));
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
      if (request.deadlineMs !== undefined && request.deadlineMs <= t) {
        // An expired deadline sends nothing, so it spends nothing either (as the semaphore).
        return Promise.resolve({
          ok: false,
          reason: 'deadline',
          retryAt: new Date(Math.ceil(readyAt(need, t))),
        });
      }
      if (queue.length === 0 && readyAt(need, t) <= t) return Promise.resolve(consume(need));
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
      penalties += 1;
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
