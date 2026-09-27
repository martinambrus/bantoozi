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

  it('refuses an expired deadline at once, without spending capacity', async () => {
    const limiter = createRateLimiter({ requestsPerMinute: 2 });
    for (const deadlineMs of [0, -1_000, 0, 0]) {
      expect(await limiter.acquire({ tokens: 10, priority: 'bulk', deadlineMs })).toEqual({
        ok: false,
        reason: 'deadline',
        retryAt: new Date(0),
      });
    }
    expect(limiter.snapshot()).toMatchObject({
      requests: 2,
      tokens: TYPESAFE_INPUT_TOKENS_PER_SECOND,
      waiting: 0,
    });
    // Without capacity, the refusal says when the request fits: one request refills in 30 s.
    await limiter.acquire({ tokens: 10, priority: 'bulk' });
    await limiter.acquire({ tokens: 10, priority: 'bulk' });
    expect(await limiter.acquire({ tokens: 10, priority: 'bulk', deadlineMs: 0 })).toEqual({
      ok: false,
      reason: 'deadline',
      retryAt: new Date(30_000),
    });
    expect(limiter.snapshot()).toMatchObject({ requests: 0, waiting: 0 });
  });

  it('gives up at the deadline while queued behind another waiter', async () => {
    const limiter = createRateLimiter({ requestsPerMinute: 1 });
    await limiter.acquire({ tokens: 1, priority: 'bulk' });
    const first = limiter.acquire({ tokens: 1, priority: 'interactive' });
    const second = limiter.acquire({ tokens: 1, priority: 'bulk', deadlineMs: 70_000 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await first).toMatchObject({ ok: true });
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

  it('gives the debit of an unsent attempt back once, up to the capacity', async () => {
    const limiter = createRateLimiter({ requestsPerMinute: 2 });
    const a = await limiter.acquire({ tokens: 1_000, priority: 'bulk' });
    const b = await limiter.acquire({ tokens: 1_000, priority: 'bulk' });
    if (!a.ok || !b.ok) throw new Error('both fit the full bucket');
    const log: Array<[string, number, boolean]> = [];
    const c = track(limiter.acquire({ tokens: 1_000, priority: 'bulk' }), log, 'c');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(log).toEqual([]);
    // b is never sent: its refund serves the waiting c at once instead of 29 s later, and a second
    // refund of it counts for nothing.
    b.refund();
    b.refund();
    await c;
    expect(log).toEqual([['c', 1_000, true]]);
    expect(limiter.snapshot().requests).toBeCloseTo(1 / 30, 9);
    // A refund never fills a bucket past its capacity.
    await vi.advanceTimersByTimeAsync(60_000);
    a.refund();
    expect(limiter.snapshot()).toMatchObject({
      requests: 2,
      tokens: TYPESAFE_INPUT_TOKENS_PER_SECOND,
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

  it('refills the penalized part of an interval at the penalized rate', async () => {
    const limiter = createRateLimiter({ requestsPerMinute: 600 });
    limiter.penalize();
    // No refill runs during the penalty: the first one after it still accrues the penalized
    // minute at 300/min, so the bucket leaves it at 300 requests instead of bursting to 600.
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_PENALTY_MS);
    expect(limiter.snapshot()).toMatchObject({
      penalized: false,
      requestCapacity: 600,
      requests: 300,
      tokens: TYPESAFE_INPUT_TOKENS_PER_SECOND / 2,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(limiter.snapshot().requests).toBe(400);
  });

  it('continues a wait that outlasts the penalty at the full rate', async () => {
    // Half a request per minute: the first request leaves a debt of half a request, and a 429
    // then halves the rate for a minute. The bucket is at -0.25 when the penalty ends and holds
    // half a request 90 s later, at 150 s, not at the 180 s the halved rate alone would take.
    const limiter = createRateLimiter({ requestsPerMinute: 1, share: 0.5 });
    await limiter.acquire({ tokens: 1, priority: 'bulk' });
    limiter.penalize();
    expect(await limiter.acquire({ tokens: 1, priority: 'bulk', deadlineMs: 140_000 })).toEqual({
      ok: false,
      reason: 'deadline',
      retryAt: new Date(150_000),
    });
    const log: Array<[string, number, boolean]> = [];
    track(limiter.acquire({ tokens: 1, priority: 'bulk', deadlineMs: 160_000 }), log, 'a');
    await vi.advanceTimersByTimeAsync(149_999);
    expect(log).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(log).toEqual([['a', 150_000, true]]);
  });

  it('measures a wait past the penalty against the full capacity', async () => {
    // A 429 empties a bucket of half a request per minute and halves it for a minute. The halved
    // bucket would hold its quarter request just as the penalty ends, but the need is half a
    // request from then on: that takes 30 s more, so a deadline at 70 s is refused at once.
    const limiter = createRateLimiter({ requestsPerMinute: 1, share: 0.5 });
    limiter.penalize();
    const log: Array<[string, number, boolean]> = [];
    const pending = track(
      limiter.acquire({ tokens: 1, priority: 'bulk', deadlineMs: 70_000 }),
      log,
      'a',
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual([['a', 0, false]]);
    expect(await pending).toEqual({ ok: false, reason: 'deadline', retryAt: new Date(90_000) });
    track(limiter.acquire({ tokens: 1, priority: 'bulk' }), log, 'b');
    await vi.advanceTimersByTimeAsync(90_000);
    expect(log.at(-1)).toEqual(['b', 90_000, true]);
  });

  it('refuses a wait with the time at which the buckets first fit the request', async () => {
    // Seeded scenarios of shares, debts and penalties: a refused acquisition's retry time must be
    // when the limiter, refilling as it does, first grants the request, a penalty's end included.
    let seed = 7;
    const random = () => (seed = (seed * 48_271) % 2_147_483_647) / 2_147_483_647;
    const between = (low: number, high: number) => low + random() * (high - low);
    let clock = 0;
    let refused = 0;
    for (let run = 0; run < 400; run += 1) {
      const tokenRate = between(50, 3_000);
      const share = between(0.1, 1);
      const limiter = createRateLimiter({
        requestsPerMinute: between(0.2, 6),
        inputTokensPerSecond: tokenRate,
        share,
        penaltyMs: between(1_000, 180_000),
        penaltyFactor: between(0.1, 1),
        now: () => clock,
      });
      /** The retry time of an expired deadline, which spends nothing. */
      const readyTime = async (tokens: number) => {
        const result = await limiter.acquire({ tokens, priority: 'bulk', deadlineMs: clock });
        if (result.ok) throw new Error('an expired deadline was granted');
        return result.retryAt.getTime();
      };
      /** Granted when the request fits now; otherwise withdrawn before it waits. */
      const acquireNow = async (tokens: number) => {
        const controller = new AbortController();
        const pending = limiter.acquire({ tokens, priority: 'bulk', signal: controller.signal });
        controller.abort();
        return (await pending).ok;
      };
      for (let step = 0; step < 6; step += 1) {
        clock += Math.floor(between(0, 60_000));
        if (random() < 0.35) {
          limiter.penalize(random() < 0.5 ? undefined : between(0, 200_000));
          continue;
        }
        const tokens = between(0, tokenRate * share * 2);
        for (let tries = 0; tries < 4; tries += 1) {
          if (await acquireNow(tokens)) break;
          clock = await readyTime(tokens);
        }
      }
      const tokens = between(0, tokenRate * share * 2);
      const retryAt = await readyTime(tokens);
      if (retryAt <= clock) {
        expect(await acquireNow(tokens)).toBe(true);
        continue;
      }
      refused += 1;
      if (retryAt - 2 > clock) {
        clock = retryAt - 2;
        expect(await acquireNow(tokens)).toBe(false);
      }
      clock = retryAt;
      expect(await acquireNow(tokens)).toBe(true);
    }
    expect(refused).toBeGreaterThan(200);
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
