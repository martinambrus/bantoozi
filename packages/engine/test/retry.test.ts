import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  backoffDelayMs,
  decideRetry,
  isTransientStatus,
  MAX_ATTEMPTS,
  MAX_RETRY_AFTER_MS,
  parseRetryAfter,
  sleep,
  type FailedAttemptInfo,
} from '../src/retry.js';

const NOW = Date.parse('2026-09-26T12:00:00.000Z');

describe('backoffDelayMs (spec 04 §4)', () => {
  it('doubles from 500 ms before attempt 2', () => {
    const noJitter = () => 0.5;
    expect([2, 3, 4, 5].map((n) => backoffDelayMs(n, noJitter))).toEqual([500, 1000, 2000, 4000]);
  });

  it('applies at most ±20 % jitter', () => {
    expect(backoffDelayMs(2, () => 0)).toBe(400);
    expect(backoffDelayMs(2, () => 1)).toBe(600);
    expect(backoffDelayMs(3, () => 0.75)).toBe(1100);
    // Out-of-range random values are clamped.
    expect(backoffDelayMs(2, () => 7)).toBe(600);
    expect(backoffDelayMs(2, () => -1)).toBe(400);
  });

  it('rejects attempts below 2', () => {
    expect(() => backoffDelayMs(1)).toThrow(RangeError);
    expect(() => backoffDelayMs(2.5)).toThrow(RangeError);
  });
});

describe('parseRetryAfter', () => {
  it('reads delay-seconds', () => {
    expect(parseRetryAfter('120', NOW)).toBe(120_000);
    expect(parseRetryAfter(' 5 ', NOW)).toBe(5_000);
    expect(parseRetryAfter('0', NOW)).toBe(0);
  });

  it('caps very long delays at 24 hours', () => {
    expect(parseRetryAfter('999999', NOW)).toBe(MAX_RETRY_AFTER_MS);
    expect(parseRetryAfter('99999999999999999999999', NOW)).toBe(MAX_RETRY_AFTER_MS);
  });

  it('reads the three HTTP-date forms', () => {
    expect(parseRetryAfter('Sat, 26 Sep 2026 12:00:30 GMT', NOW)).toBe(30_000);
    expect(parseRetryAfter('Saturday, 26-Sep-26 12:01:00 GMT', NOW)).toBe(60_000);
    expect(parseRetryAfter('Sat Sep 26 12:00:10 2026', NOW)).toBe(10_000);
    expect(parseRetryAfter('Sat Sep  6 12:00:10 2026', NOW)).toBe(0);
  });

  it('treats a past date as no delay and a far date as the cap', () => {
    expect(parseRetryAfter('Sun, 06 Nov 1994 08:49:37 GMT', NOW)).toBe(0);
    expect(parseRetryAfter('Fri, 01 Jan 2027 00:00:00 GMT', NOW)).toBe(MAX_RETRY_AFTER_MS);
  });

  it('ignores values that are neither seconds nor an HTTP date', () => {
    for (const value of [
      '5.5',
      '-1',
      'soon',
      '',
      '2026-09-26T12:00:30Z',
      'Sat, 99 Sep 2026 12:00:30 GMT',
    ]) {
      expect(parseRetryAfter(value, NOW)).toBeUndefined();
    }
    expect(parseRetryAfter(undefined, NOW)).toBeUndefined();
    expect(parseRetryAfter(null, NOW)).toBeUndefined();
  });
});

describe('decideRetry', () => {
  const info = (patch: Partial<FailedAttemptInfo>): FailedAttemptInfo => ({
    engine: 'typesafe',
    attempt: 1,
    status: 'error',
    retryable: true,
    invalidResponseRetries: 0,
    ...patch,
  });
  const mid = () => 0.5;

  it('retries 429, 5xx/network errors and timeouts with the backoff', () => {
    for (const status of ['error', 'timeout', 'rate_limited'] as const) {
      expect(decideRetry(info({ status }), mid)).toEqual({ retry: true, delayMs: 500 });
    }
    expect(decideRetry(info({ attempt: 3 }), mid)).toEqual({ retry: true, delayMs: 2000 });
  });

  it('never retries sooner than the server asked', () => {
    expect(decideRetry(info({ retryAfterMs: 7_000 }), mid)).toEqual({
      retry: true,
      delayMs: 7_000,
    });
    expect(decideRetry(info({ retryAfterMs: 100 }), mid)).toEqual({ retry: true, delayMs: 500 });
    expect(decideRetry(info({ retryAfterMs: Number.NaN }), mid)).toEqual({
      retry: true,
      delayMs: 500,
    });
  });

  it('does not retry auth errors, invalid requests or permanent failures', () => {
    expect(decideRetry(info({ status: 'auth_error' }), mid)).toEqual({
      retry: false,
      reason: 'not_retryable',
    });
    expect(decideRetry(info({ status: 'invalid_request' }), mid)).toEqual({
      retry: false,
      reason: 'not_retryable',
    });
    expect(decideRetry(info({ retryable: false }), mid)).toEqual({
      retry: false,
      reason: 'not_retryable',
    });
  });

  it('retries at most one invalid_response', () => {
    expect(decideRetry(info({ status: 'invalid_response' }), mid).retry).toBe(true);
    expect(
      decideRetry(info({ status: 'invalid_response', invalidResponseRetries: 1 }), mid).retry,
    ).toBe(false);
  });

  it('stops at 4 TypeSafe and 2 LLM attempts', () => {
    expect(MAX_ATTEMPTS).toMatchObject({ typesafe: 4, llm: 2 });
    expect(decideRetry(info({ attempt: 3 }), mid).retry).toBe(true);
    expect(decideRetry(info({ attempt: 4 }), mid)).toEqual({ retry: false, reason: 'exhausted' });
    expect(decideRetry(info({ engine: 'llm', attempt: 1 }), mid).retry).toBe(true);
    expect(decideRetry(info({ engine: 'llm', attempt: 2 }), mid)).toEqual({
      retry: false,
      reason: 'exhausted',
    });
  });

  it('classifies transient statuses', () => {
    expect(isTransientStatus('timeout')).toBe(true);
    expect(isTransientStatus('auth_error')).toBe(false);
  });
});

describe('sleep', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves true once the time has passed', async () => {
    let done: boolean | undefined;
    void sleep(1_000).then((value) => {
      done = value;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it('resolves false as soon as the signal aborts, and clears its timer', async () => {
    const controller = new AbortController();
    const pending = sleep(10_000, controller.signal);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    expect(await pending).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves false at once for an aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await sleep(10_000, controller.signal)).toBe(false);
  });
});
