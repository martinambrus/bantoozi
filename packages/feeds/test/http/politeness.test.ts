import type { OriginLimiter, OriginReservation } from '@bantoozi/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_COOLDOWN_MS, LEASE_MARGIN_MS } from '../../src/http/safe-fetch.js';
import {
  expectFailure,
  expectOk,
  fakeLimiter,
  startSeamHarness,
  type SeamHarness,
} from './helpers.js';

const NOW = Date.UTC(2026, 8, 26, 12, 0, 0);
const now = (): number => NOW;

let harness: SeamHarness;

beforeAll(async () => {
  harness = await startSeamHarness();
});

afterAll(async () => {
  await harness.close();
});

beforeEach(() => {
  harness.fixture.reset();
  harness.dialed.length = 0;
});

describe('spec 03 §8.2 politeness through the injected OriginLimiter', () => {
  it('reserves every hop at its own origin under a lease longer than the deadline and releases it', async () => {
    const { limiter, calls } = fakeLimiter((_origin, attempt) => ({
      status: 'granted',
      token: `t${attempt}`,
    }));
    harness.fixture.redirect('/start', 'http://other.example:8080/feed', 301);
    harness.fixture.route('/feed', { body: 'x' });
    expectOk(await harness.fetch('http://public.example/start', { limiter, timeoutMs: 4_000 }));
    const leaseMs = 4_000 + LEASE_MARGIN_MS;
    expect(calls.reserve).toEqual([
      { origin: 'http://public.example:80', leaseMs },
      { origin: 'http://other.example:8080', leaseMs },
    ]);
    expect(calls.release).toEqual([
      { origin: 'http://public.example:80', token: 't1' },
      { origin: 'http://other.example:8080', token: 't2' },
    ]);
    expect(calls.block).toEqual([]);
  });

  it('blocked → FEED_ORIGIN_COOLDOWN with retryAt = until, and zero requests', async () => {
    const until = new Date(NOW + 3_600_000);
    const { limiter, calls } = fakeLimiter(() => ({ status: 'blocked', until }));
    harness.fixture.route('/feed', { body: 'x' });
    const result = expectFailure(
      await harness.fetch('http://public.example/feed', { limiter, now }),
    );
    expect(result).toMatchObject({
      code: 'FEED_ORIGIN_COOLDOWN',
      retryAt: until,
      finalUrl: 'http://public.example/feed',
    });
    expect(calls.reserve).toHaveLength(1);
    expect(calls.release).toEqual([]);
    expect(harness.dialed).toEqual([]);
    expect(harness.fixture.requests).toEqual([]);
  });

  it('wait → sleeps until retryAt, asks again and proceeds', async () => {
    const { limiter, calls } = fakeLimiter((_origin, attempt) =>
      attempt === 1
        ? { status: 'wait', retryAt: new Date(NOW + 150) }
        : { status: 'granted', token: 'second' },
    );
    harness.fixture.route('/feed', { body: 'x' });
    const started = Date.now();
    expectOk(await harness.fetch('http://public.example/feed', { limiter, now }));
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(calls.reserve).toHaveLength(2);
    expect(calls.release).toEqual([{ origin: 'http://public.example:80', token: 'second' }]);
    expect(harness.fixture.requests).toHaveLength(1);
  });

  it('wait until after the deadline → FEED_ORIGIN_COOLDOWN with retryAt, no request', async () => {
    const retryAt = new Date(NOW + 10_000);
    const { limiter, calls } = fakeLimiter(() => ({ status: 'wait', retryAt }));
    const result = expectFailure(
      await harness.fetch('http://public.example/feed', { limiter, now, timeoutMs: 5_000 }),
    );
    expect(result).toMatchObject({ code: 'FEED_ORIGIN_COOLDOWN', retryAt });
    expect(calls.reserve).toHaveLength(1);
    expect(harness.fixture.requests).toEqual([]);
  });

  it('a limiter answering wait for a past instant cannot spin: the deadline ends it', async () => {
    const { limiter, calls } = fakeLimiter(() => ({ status: 'wait', retryAt: new Date(0) }));
    const result = await harness.fetch('http://public.example/feed', { limiter, timeoutMs: 200 });
    expect(result).toMatchObject({ ok: false, code: 'FEED_TIMEOUT' });
    expect(calls.reserve.length).toBeGreaterThan(1);
    expect(calls.reserve.length).toBeLessThanOrEqual(21);
    expect(harness.fixture.requests).toEqual([]);
  });

  it('an invalid retryAt from the limiter is a programming error', async () => {
    const { limiter } = fakeLimiter(() => ({ status: 'wait', retryAt: new Date(Number.NaN) }));
    await expect(harness.fetch('http://public.example/feed', { limiter })).rejects.toThrow(
      /invalid retryAt/,
    );
  });

  describe('429/503 persist an origin cooldown', () => {
    it('429 with Retry-After seconds → block(origin, now + seconds) and retryAt', async () => {
      const { limiter, calls } = fakeLimiter();
      harness.fixture.route('/feed', { status: 429, headers: { 'retry-after': '120' } });
      const result = expectFailure(
        await harness.fetch('http://public.example/feed', { limiter, now }),
      );
      const until = new Date(NOW + 120_000);
      expect(result).toMatchObject({ code: 'FEED_HTTP_429', status: 429, retryAt: until });
      expect(calls.block).toEqual([{ origin: 'http://public.example:80', until }]);
      expect(calls.release).toHaveLength(1);
    });

    it('503 with an HTTP-date Retry-After → blocks until that date', async () => {
      const { limiter, calls } = fakeLimiter();
      harness.fixture.route('/feed', {
        status: 503,
        headers: { 'retry-after': 'Sat, 26 Sep 2026 13:30:00 GMT' },
      });
      const result = expectFailure(
        await harness.fetch('http://public.example/feed', { limiter, now }),
      );
      const until = new Date(Date.UTC(2026, 8, 26, 13, 30, 0));
      expect(result).toMatchObject({ code: 'FEED_HTTP_503', retryAt: until });
      expect(calls.block).toEqual([{ origin: 'http://public.example:80', until }]);
    });

    it.each([
      [429, undefined],
      [503, undefined],
      [429, 'soon'],
      [503, '-5'],
      [429, '1.5'],
    ])('%i with Retry-After %s → at least 60 s', async (status, retryAfter) => {
      const { limiter, calls } = fakeLimiter();
      harness.fixture.route('/feed', {
        status,
        headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
      });
      const result = expectFailure(
        await harness.fetch('http://public.example/feed', { limiter, now }),
      );
      const until = new Date(NOW + DEFAULT_COOLDOWN_MS);
      expect(DEFAULT_COOLDOWN_MS).toBeGreaterThanOrEqual(60_000);
      expect(result.retryAt).toEqual(until);
      expect(calls.block).toEqual([{ origin: 'http://public.example:80', until }]);
    });

    it('clamps a longer Retry-After to 24 h', async () => {
      const { limiter, calls } = fakeLimiter();
      harness.fixture.route('/feed', { status: 429, headers: { 'retry-after': '999999' } });
      const result = expectFailure(
        await harness.fetch('http://public.example/feed', { limiter, now }),
      );
      expect(result.retryAt).toEqual(new Date(NOW + 86_400_000));
      expect(calls.block[0]?.until).toEqual(new Date(NOW + 86_400_000));
    });

    it('works without a limiter: retryAt is still returned', async () => {
      harness.fixture.route('/feed', { status: 429, headers: { 'retry-after': '30' } });
      const result = expectFailure(await harness.fetch('http://public.example/feed', { now }));
      expect(result.retryAt).toEqual(new Date(NOW + 30_000));
    });

    it('other statuses never block the origin', async () => {
      const { limiter, calls } = fakeLimiter();
      harness.fixture.route('/feed', { status: 500, headers: { 'retry-after': '120' } });
      expect(await harness.fetch('http://public.example/feed', { limiter, now })).toMatchObject({
        code: 'FEED_HTTP_500',
      });
      expect(calls.block).toEqual([]);
    });
  });

  describe('release() is always called, including on errors', () => {
    it.each([
      ['success', () => harness.fixture.route('/feed', { body: 'x' }), {}],
      ['HTTP 500', () => harness.fixture.route('/feed', { status: 500 }), {}],
      [
        'body too large',
        () => harness.fixture.route('/feed', { body: 'x'.repeat(2048) }),
        { maxBytes: 1024 },
      ],
      [
        'corrupt encoding',
        () =>
          harness.fixture.route('/feed', { headers: { 'content-encoding': 'gzip' }, body: 'no' }),
        {},
      ],
      [
        'timeout',
        () => harness.fixture.route('/feed', { delayMs: 1_000, body: 'x' }),
        { timeoutMs: 200 },
      ],
      [
        'blocked redirect target',
        () => harness.fixture.redirect('/feed', 'http://internal.example/', 302),
        {},
      ],
      [
        'too many redirects',
        () => harness.fixture.redirect('/feed', '/feed2', 302),
        { maxRedirects: 0 },
      ],
    ] as const)('%s', async (_label, setUp, overrides) => {
      setUp();
      const { limiter, calls } = fakeLimiter((_origin, attempt) => ({
        status: 'granted',
        token: `t${attempt}`,
      }));
      await harness.fetch('http://public.example/feed', { limiter, ...overrides });
      expect(calls.reserve.length).toBeGreaterThan(0);
      expect(calls.release.map((call) => call.token)).toEqual(
        calls.reserve.map((_call, index) => `t${index + 1}`),
      );
    });

    it('a failing release or block never changes the result', async () => {
      const limiter: OriginLimiter = {
        reserve: () => Promise.resolve({ status: 'granted', token: 't' }),
        release: () => Promise.reject(new Error('db down')),
        block: () => {
          throw new Error('db down');
        },
      };
      harness.fixture.route('/feed', { body: 'x' });
      expectOk(await harness.fetch('http://public.example/feed', { limiter }));
      harness.fixture.route('/feed', { status: 429, headers: { 'retry-after': '10' } });
      expect(await harness.fetch('http://public.example/feed', { limiter, now })).toMatchObject({
        code: 'FEED_HTTP_429',
        retryAt: new Date(NOW + 10_000),
      });
    });

    it('a failing reserve rejects the fetch (infrastructure error) and sends nothing', async () => {
      const limiter: OriginLimiter = {
        reserve: () => Promise.reject(new Error('db down')),
        release: () => Promise.resolve(),
        block: () => Promise.resolve(),
      };
      await expect(harness.fetch('http://public.example/feed', { limiter })).rejects.toThrow(
        'db down',
      );
      expect(harness.fixture.requests).toEqual([]);
    });

    it('a start granted only after the deadline is released at once', async () => {
      const release = vi.fn(() => Promise.resolve());
      const limiter: OriginLimiter = {
        reserve: () =>
          new Promise<OriginReservation>((resolve) => {
            setTimeout(() => resolve({ status: 'granted', token: 'late' }), 300);
          }),
        release,
        block: () => Promise.resolve(),
      };
      const result = await harness.fetch('http://public.example/feed', { limiter, timeoutMs: 100 });
      expect(result).toMatchObject({ ok: false, code: 'FEED_TIMEOUT' });
      await vi.waitFor(() => {
        expect(release).toHaveBeenCalledWith('http://public.example:80', 'late');
      });
      expect(harness.fixture.requests).toEqual([]);
    });
  });
});

describe('spec 03 §4 beforeRequest policy callback (robots checks for article redirects)', () => {
  it('runs before every request with the URL and the hop index', async () => {
    harness.fixture.redirect('/a', 'http://other.example/b', 302);
    harness.fixture.route('/b', { body: 'x' });
    const seen: [string, number][] = [];
    expectOk(
      await harness.fetch('http://public.example/a', {
        beforeRequest: (url, hop) => {
          seen.push([url.href, hop]);
          return Promise.resolve(true);
        },
      }),
    );
    expect(seen).toEqual([
      ['http://public.example/a', 0],
      ['http://other.example/b', 1],
    ]);
  });

  it('a denial on hop 0 → FEED_POLICY_DENIED; nothing is reserved or sent', async () => {
    const { limiter, calls } = fakeLimiter();
    const policy = { code: 'ROBOTS_DISALLOWED', message: 'disallowed by robots.txt' };
    const result = expectFailure(
      await harness.fetch('http://public.example/a', {
        limiter,
        beforeRequest: () => Promise.resolve(policy),
      }),
    );
    expect(result).toMatchObject({
      code: 'FEED_POLICY_DENIED',
      policy,
      finalUrl: 'http://public.example/a',
      redirects: [],
    });
    expect(calls.reserve).toEqual([]);
    expect(harness.fixture.requests).toEqual([]);
  });

  it('a denial on a redirect hop ends the fetch at that URL', async () => {
    harness.fixture.redirect('/a', 'http://other.example/private', 301);
    const policy = { code: 'ROBOTS_DISALLOWED', message: 'disallowed by robots.txt' };
    const result = expectFailure(
      await harness.fetch('http://public.example/a', {
        beforeRequest: (url) => Promise.resolve(url.hostname === 'other.example' ? policy : true),
      }),
    );
    expect(result).toMatchObject({
      code: 'FEED_POLICY_DENIED',
      policy,
      finalUrl: 'http://other.example/private',
      redirects: [
        { status: 301, from: 'http://public.example/a', to: 'http://other.example/private' },
      ],
    });
    expect(harness.fixture.requests.map((request) => request.path)).toEqual(['/a']);
  });

  it('runs after the URL checks and before the limiter', async () => {
    const order: string[] = [];
    const { limiter } = fakeLimiter();
    const tracked: OriginLimiter = {
      ...limiter,
      reserve: (origin, opts) => {
        order.push('reserve');
        return limiter.reserve(origin, opts);
      },
    };
    const beforeRequest = (url: URL): Promise<true> => {
      order.push(`policy ${url.hostname}`);
      return Promise.resolve(true);
    };
    harness.fixture.redirect('/a', 'http://127.0.0.1/', 302);
    const result = await harness.fetch('http://public.example/a', {
      limiter: tracked,
      beforeRequest,
    });
    expect(result).toMatchObject({ code: 'FEED_BLOCKED_ADDRESS' });
    // The blocked literal of hop 1 never reached the callback or the limiter.
    expect(order).toEqual(['policy public.example', 'reserve']);
  });

  it('receives a copy: mutating the URL changes nothing', async () => {
    harness.fixture.route('/a', { body: 'x' });
    const result = expectOk(
      await harness.fetch('http://public.example/a', {
        beforeRequest: (url) => {
          url.hostname = '127.0.0.1';
          url.pathname = '/evil';
          return Promise.resolve(true);
        },
      }),
    );
    expect(result.finalUrl).toBe('http://public.example/a');
    expect(harness.fixture.requests.map((request) => request.path)).toEqual(['/a']);
  });

  it('a throwing callback rejects the fetch', async () => {
    await expect(
      harness.fetch('http://public.example/a', {
        beforeRequest: () => Promise.reject(new Error('robots store unavailable')),
      }),
    ).rejects.toThrow('robots store unavailable');
    expect(harness.fixture.requests).toEqual([]);
  });

  it('a slow callback is bounded by the deadline', async () => {
    const result = await harness.fetch('http://public.example/a', {
      timeoutMs: 150,
      beforeRequest: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(true), 1_000);
        }),
    });
    expect(result).toMatchObject({ ok: false, code: 'FEED_TIMEOUT' });
    expect(harness.fixture.requests).toEqual([]);
  });
});
