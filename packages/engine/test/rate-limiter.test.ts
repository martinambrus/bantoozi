import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRateLimiter,
  RATE_LIMIT_PENALTY_MS,
  TYPESAFE_INPUT_TOKENS_PER_SECOND,
  TYPESAFE_REQUESTS_PER_MINUTE,
  type RateLimitAcquisition,
} from '../src/rate-limiter.js';

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Resolve times (fake ms) of acquisitions, recorded as they settle. */
function track(
  promise: Promise<RateLimitAcquisition>,
  log: Array<[string, number, boolean]>,
  name: string,
) {
  void promise.then((r) => log.push([name, Date.now(), r.ok]));
  return promise;
}

describe('createRateLimiter (spec 04 §3)', () => {
  it('defaults to the published account limits', () => {
    const snapshot = createRateLimiter().snapshot();
    expect(snapshot.requestCapacity).toBe(TYPESAFE_REQUESTS_PER_MINUTE);
    expect(snapshot.tokenCapacity).toBe(TYPESAFE_INPUT_TOKENS_PER_SECOND);
    expect(snapshot.penalized).toBe(false);
  });

  it('scales both buckets by the process share', () => {
    const snapshot = createRateLimiter({ share: 0.25 }).snapshot();
    expect(snapshot.requestCapacity).toBe(250);
    expect(snapshot.tokenCapacity).toBe(50_000);
  });

  it('waits for the request bucket to refill', async () => {
    const limiter = createRateLimiter({ requestsPerMinute: 2 });
    const log: Array<[string, number, boolean]> = [];
    await track(limiter.acquire({ tokens: 1, priority: 'bulk' }), log, 'a');
    await track(limiter.acquire({ tokens: 1, priority: 'bulk' }), log, 'b');
    const c = track(limiter.acquire({ tokens: 1, priority: 'bulk' }), log, 'c');
    await vi.advanceTimersByTimeAsync(29_999);
    expect(log.map(([n]) => n)).toEqual(['a', 'b']);
    await vi.advanceTimersByTimeAsync(1);
    await c;
    expect(log.at(-1)).toEqual(['c', 30_000, true]);
  });

  it('waits for input-token capacity, and lets an oversized request leave a debt', async () => {
    const limiter = createRateLimiter({ inputTokensPerSecond: 1_000 });
    const log: Array<[string, number, boolean]> = [];
    await track(limiter.acquire({ tokens: 800, priority: 'bulk' }), log, 'a');
    const b = track(limiter.acquire({ tokens: 600, priority: 'bulk' }), log, 'b');
    await vi.advanceTimersByTimeAsync(400);
    await b;
    expect(log.at(-1)).toEqual(['b', 400, true]);
    // Larger than the bucket: waits for a full bucket, then leaves the rest as debt.
    const c = track(limiter.acquire({ tokens: 2_500, priority: 'bulk' }), log, 'c');
    await vi.advanceTimersByTimeAsync(1_000);
    await c;
    expect(log.at(-1)).toEqual(['c', 1_400, true]);
    expect(limiter.snapshot().tokens).toBeLessThan(0);
  });

  it('serves a request bucket below one request at its refill rate, leaving a debt', async () => {
    // A quarter share of 1 request/min holds a quarter of a request: one request every 4 minutes.
    const limiter = createRateLimiter({ requestsPerMinute: 1, share: 0.25 });
    const log: Array<[string, number, boolean]> = [];
    track(limiter.acquire({ tokens: 1, priority: 'bulk' }), log, 'a');
    track(limiter.acquire({ tokens: 1, priority: 'bulk' }), log, 'b');
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual([['a', 0, true]]);
    expect(limiter.snapshot().requests).toBeLessThan(0);
    await vi.advanceTimersByTimeAsync(239_999);
    expect(log).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(log).toEqual([
      ['a', 0, true],
      ['b', 240_000, true],
    ]);
  });

  it('keeps serving at the penalized rate when a 429 leaves less than one request', async () => {
    const limiter = createRateLimiter({ requestsPerMinute: 1, penaltyMs: 600_000 });
    limiter.penalize();
    const log: Array<[string, number, boolean]> = [];
    track(limiter.acquire({ tokens: 1, priority: 'bulk' }), log, 'a');
    track(limiter.acquire({ tokens: 1, priority: 'bulk' }), log, 'b');
    await vi.advanceTimersByTimeAsync(180_000);
    expect(log).toEqual([
      ['a', 60_000, true],
      ['b', 180_000, true],
    ]);
    expect(limiter.snapshot().penalized).toBe(true);
  });

  it('refuses a wait that would pass the deadline, with the expected retry time', async () => {
    const limiter = createRateLimiter({ requestsPerMinute: 1 });
    await limiter.acquire({ tokens: 1, priority: 'bulk' });
    const result = await limiter.acquire({ tokens: 1, priority: 'bulk', deadlineMs: 5_000 });
    expect(result).toEqual({ ok: false, reason: 'deadline', retryAt: new Date(60_000) });
  });

  it('gives up at the deadline while queued behind another waiter', async () => {
    const limiter = createRateLimiter({ requestsPerMinute: 1 });
    await limiter.acquire({ tokens: 1, priority: 'bulk' });
    const first = limiter.acquire({ tokens: 1, priority: 'interactive' });
    const second = limiter.acquire({ tokens: 1, priority: 'bulk', deadlineMs: 70_000 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await first).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await second;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('deadline');
      expect(result.retryAt.getTime()).toBeGreaterThanOrEqual(120_000);
    }
  });

  it('stops waiting when cancelled', async () => {
    const limiter = createRateLimiter({ requestsPerMinute: 1 });
    await limiter.acquire({ tokens: 1, priority: 'bulk' });
    const controller = new AbortController();
    const pending = limiter.acquire({ tokens: 1, priority: 'bulk', signal: controller.signal });
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    expect(await pending).toEqual({ ok: false, reason: 'cancelled', retryAt: new Date(1_000) });
    expect(limiter.snapshot().waiting).toBe(0);
    const aborted = new AbortController();
    aborted.abort();
    expect(
      await limiter.acquire({ tokens: 1, priority: 'bulk', signal: aborted.signal }),
    ).toMatchObject({
      ok: false,
      reason: 'cancelled',
    });
  });

  it('serves interactive waiters first, with aging for bulk', async () => {
    const limiter = createRateLimiter({ requestsPerMinute: 60, agingMs: 5_000 });
    // Drain the bucket.
    for (let i = 0; i < 60; i += 1) await limiter.acquire({ tokens: 0, priority: 'bulk' });
    const log: Array<[string, number, boolean]> = [];
    track(limiter.acquire({ tokens: 0, priority: 'bulk' }), log, 'bulk-old');
    await vi.advanceTimersByTimeAsync(10);
    track(limiter.acquire({ tokens: 0, priority: 'bulk' }), log, 'bulk');
    track(limiter.acquire({ tokens: 0, priority: 'interactive' }), log, 'interactive');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(log.map(([n]) => n)).toEqual(['interactive', 'bulk-old', 'bulk']);
  });

  it('lowers capacity after a 429 and honours its delay', async () => {
    const limiter = createRateLimiter({ requestsPerMinute: 600 });
    limiter.penalize(2_000);
    const snapshot = limiter.snapshot();
    expect(snapshot.penalized).toBe(true);
    expect(snapshot.requestCapacity).toBe(300);
    expect(snapshot.blockedUntil).toBe(2_000);
    const log: Array<[string, number, boolean]> = [];
    const pending = track(limiter.acquire({ tokens: 1, priority: 'bulk' }), log, 'a');
    await vi.advanceTimersByTimeAsync(2_000);
    await pending;
    expect(log).toEqual([['a', 2_000, true]]);
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_PENALTY_MS);
    expect(limiter.snapshot()).toMatchObject({ penalized: false, requestCapacity: 600 });
  });

  it('penalizes without a server delay too', () => {
    const limiter = createRateLimiter({ requestsPerMinute: 600 });
    limiter.penalize();
    expect(limiter.snapshot()).toMatchObject({ penalized: true, requests: 0 });
  });

  it('validates its options and requests', async () => {
    expect(() => createRateLimiter({ share: 0 })).toThrow(RangeError);
    expect(() => createRateLimiter({ share: 1.5 })).toThrow(RangeError);
    expect(() => createRateLimiter({ requestsPerMinute: 0 })).toThrow(RangeError);
    expect(() => createRateLimiter({ penaltyFactor: 0 })).toThrow(RangeError);
    await expect(createRateLimiter().acquire({ tokens: -1, priority: 'bulk' })).rejects.toThrow(
      RangeError,
    );
  });
});
