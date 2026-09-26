import { describe, expect, it } from 'vitest';

import { createRobotsChecker, type RobotsCheckerOptions } from '../../src/extract/index.js';
import type { SafeFetchResult } from '../../src/http/index.js';

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

function robotsTxt(body: string, finalUrl = 'https://example.com/robots.txt'): SafeFetchResult {
  return {
    ok: true,
    status: 200,
    finalUrl,
    permanentRedirect: false,
    redirects: [],
    headers: { 'content-type': 'text/plain' },
    bodyBytes: new TextEncoder().encode(body),
  };
}

function httpFailure(status: number, retryAt?: Date): SafeFetchResult {
  return {
    ok: false,
    code: `FEED_HTTP_${status}`,
    status,
    message: `HTTP ${status}`,
    ...(retryAt === undefined ? {} : { retryAt }),
  };
}

function failure(
  code:
    | 'FEED_TIMEOUT'
    | 'FEED_DNS_ERROR'
    | 'FEED_CONNECTION_ERROR'
    | 'FEED_TLS_ERROR'
    | 'FEED_TOO_LARGE'
    | 'FEED_TOO_MANY_REDIRECTS'
    | 'FEED_BLOCKED_ADDRESS',
): SafeFetchResult {
  return { ok: false, code, message: code };
}

/** A robots checker over a scripted fetch and a manual clock. */
function harness(
  respond: (url: string, call: number) => SafeFetchResult | Promise<SafeFetchResult>,
  overrides: Partial<RobotsCheckerOptions> = {},
) {
  const clock = { now: 0 };
  const calls: Array<{ url: string; purpose: string }> = [];
  const checker = createRobotsChecker({
    fetch: async (url, purpose) => {
      calls.push({ url, purpose });
      return respond(url, calls.length);
    },
    now: () => clock.now,
    ...overrides,
  });
  const check = (url: string) => checker.check(new URL(url));
  return { clock, calls, check };
}

const RULES = [
  '# robots for example.com',
  'User-agent: *',
  'Disallow: /private/',
  '',
  'User-agent: BantooziBot',
  'Disallow: /members/',
  'Allow: /members/free/',
  '',
].join('\n');

describe('spec 03 §8.1 step 2 robots.txt (RFC 9309)', () => {
  it('fetches /robots.txt once per origin with purpose robots and applies our group', async () => {
    const { calls, check } = harness(() => robotsTxt(RULES));
    await expect(check('https://example.com/members/story')).resolves.toEqual({
      allowed: false,
      reason: 'disallowed',
    });
    await expect(check('https://example.com/members/free/story?x=1')).resolves.toEqual({
      allowed: true,
      reason: 'allowed',
    });
    // Our group replaces the `*` group entirely.
    await expect(check('https://example.com/private/story')).resolves.toMatchObject({
      allowed: true,
    });
    await expect(check('https://example.com/')).resolves.toMatchObject({ allowed: true });
    expect(calls).toEqual([{ url: 'https://example.com/robots.txt', purpose: 'robots' }]);
  });

  it('matches the product token case-insensitively and ignores its version', async () => {
    const { check } = harness(() =>
      robotsTxt('﻿User-agent: bantoozibot/2.1\r\nDisallow: /\r\n\r\nUser-agent: *\r\nAllow: /\r\n'),
    );
    await expect(check('https://example.com/a')).resolves.toMatchObject({ allowed: false });
  });

  it('falls back to the * group and keeps origins (scheme, host, port) apart', async () => {
    const { calls, check } = harness((url) =>
      url.startsWith('https://example.com/')
        ? robotsTxt('User-agent: *\nDisallow: /')
        : robotsTxt(''),
    );
    await expect(check('https://example.com/a')).resolves.toMatchObject({ allowed: false });
    await expect(check('http://example.com/a')).resolves.toMatchObject({ allowed: true });
    await expect(check('https://example.com:8443/a')).resolves.toMatchObject({ allowed: true });
    await expect(check('https://www.example.com/a')).resolves.toMatchObject({ allowed: true });
    expect(calls.map((call) => call.url)).toEqual([
      'https://example.com/robots.txt',
      'http://example.com/robots.txt',
      'https://example.com:8443/robots.txt',
      'https://www.example.com/robots.txt',
    ]);
  });

  it('applies the rules of a redirected robots.txt to the origin that was asked', async () => {
    const { check } = harness(() =>
      robotsTxt('User-agent: *\nDisallow: /secret', 'https://www.example.com/robots.txt'),
    );
    await expect(check('https://example.com/secret/1')).resolves.toMatchObject({ allowed: false });
    await expect(check('https://example.com/open/1')).resolves.toMatchObject({ allowed: true });
  });

  it.each([404, 410, 400, 418])(
    'treats HTTP %i as unavailable: allow all, cached 24 h',
    async (status) => {
      const { clock, calls, check } = harness(() => httpFailure(status));
      await expect(check('https://example.com/a')).resolves.toEqual({
        allowed: true,
        reason: 'allowed',
      });
      clock.now = 24 * HOUR - 1;
      await expect(check('https://example.com/b')).resolves.toMatchObject({ allowed: true });
      expect(calls).toHaveLength(1);
      clock.now = 24 * HOUR;
      await check('https://example.com/c');
      expect(calls).toHaveLength(2);
    },
  );

  it.each([401, 403])('conservatively disallows everything on HTTP %i', async (status) => {
    const { calls, check } = harness(() => httpFailure(status));
    await expect(check('https://example.com/a')).resolves.toEqual({
      allowed: false,
      reason: 'disallowed',
    });
    await expect(check('https://example.com/b')).resolves.toMatchObject({ allowed: false });
    expect(calls).toHaveLength(1);
  });

  it('observes the origin cooldown on 429 and does not refetch before it ends', async () => {
    const retryAt = new Date(10 * MINUTE);
    const { clock, calls, check } = harness((_url, call) =>
      call === 1 ? httpFailure(429, retryAt) : robotsTxt(''),
    );
    await expect(check('https://example.com/a')).resolves.toEqual({
      allowed: false,
      reason: 'cooldown',
      retryAt,
    });
    clock.now = 10 * MINUTE - 1;
    await expect(check('https://example.com/a')).resolves.toMatchObject({ reason: 'cooldown' });
    expect(calls).toHaveLength(1);
    clock.now = 10 * MINUTE;
    await expect(check('https://example.com/a')).resolves.toMatchObject({ allowed: true });
    expect(calls).toHaveLength(2);
  });

  it('uses at least 60 s for a 429 without retryAt and treats 503 + Retry-After as a cooldown', async () => {
    const tooMany = harness(() => httpFailure(429));
    tooMany.clock.now = 5000;
    await expect(tooMany.check('https://example.com/a')).resolves.toEqual({
      allowed: false,
      reason: 'cooldown',
      retryAt: new Date(65_000),
    });

    const unavailable = harness(() => httpFailure(503, new Date(2 * HOUR)));
    await expect(unavailable.check('https://example.com/a')).resolves.toMatchObject({
      reason: 'cooldown',
      retryAt: new Date(2 * HOUR),
    });

    const throttled = harness(() => ({
      ok: false,
      code: 'FEED_ORIGIN_COOLDOWN',
      message: 'cooling down',
      retryAt: new Date(3000),
    }));
    await expect(throttled.check('https://example.com/a')).resolves.toMatchObject({
      reason: 'cooldown',
      retryAt: new Date(3000),
    });

    const pastRetry = harness(() => ({
      ok: false,
      code: 'FEED_ORIGIN_COOLDOWN',
      message: 'x',
      retryAt: new Date(0),
    }));
    pastRetry.clock.now = 1000;
    await expect(pastRetry.check('https://example.com/a')).resolves.toMatchObject({
      retryAt: new Date(61_000),
    });
  });

  it.each<[string, () => SafeFetchResult]>([
    ['HTTP 500', () => httpFailure(500)],
    ['HTTP 502', () => httpFailure(502)],
    ['HTTP 503 without Retry-After', () => httpFailure(503)],
    ['a timeout', () => failure('FEED_TIMEOUT')],
    ['a DNS error', () => failure('FEED_DNS_ERROR')],
    ['a connection error', () => failure('FEED_CONNECTION_ERROR')],
    ['a TLS error', () => failure('FEED_TLS_ERROR')],
    ['a blocked address', () => failure('FEED_BLOCKED_ADDRESS')],
  ])('treats %s as unreachable: disallow without a cached rule', async (_name, respond) => {
    const { check } = harness(respond);
    await expect(check('https://example.com/a')).resolves.toEqual({
      allowed: false,
      reason: 'unreachable',
    });
  });

  it('caches an unreachable robots.txt for 5 minutes, not 24 h', async () => {
    const { clock, calls, check } = harness((_url, call) =>
      call === 1 ? httpFailure(500) : robotsTxt('User-agent: *\nDisallow: /x'),
    );
    await expect(check('https://example.com/a')).resolves.toMatchObject({ reason: 'unreachable' });
    clock.now = 5 * MINUTE - 1;
    await expect(check('https://example.com/a')).resolves.toMatchObject({ reason: 'unreachable' });
    expect(calls).toHaveLength(1);
    clock.now = 5 * MINUTE;
    await expect(check('https://example.com/a')).resolves.toEqual({
      allowed: true,
      reason: 'allowed',
    });
    await expect(check('https://example.com/x')).resolves.toMatchObject({ allowed: false });
    expect(calls).toHaveLength(2);
  });

  it('keeps using an unexpired cached rule while robots.txt is unreachable', async () => {
    const { clock, calls, check } = harness((_url, call) =>
      call === 1 ? robotsTxt('User-agent: *\nDisallow: /x') : failure('FEED_TIMEOUT'),
    );
    await expect(check('https://example.com/a')).resolves.toMatchObject({ allowed: true });
    // Past the 24 h freshness the refresh times out: the cached rules still decide.
    clock.now = 24 * HOUR;
    await expect(check('https://example.com/a')).resolves.toEqual({
      allowed: true,
      reason: 'allowed',
    });
    await expect(check('https://example.com/x')).resolves.toEqual({
      allowed: false,
      reason: 'disallowed',
    });
    expect(calls).toHaveLength(2);
    // Every 5 minutes a new attempt; once the rules are 48 h old they have expired.
    clock.now = 48 * HOUR;
    await expect(check('https://example.com/a')).resolves.toEqual({
      allowed: false,
      reason: 'unreachable',
    });
    expect(calls).toHaveLength(3);
  });

  it('honours maxStaleMs, ttlMs and failureTtlMs overrides', async () => {
    const { clock, calls, check } = harness(
      (_url, call) => (call === 1 ? robotsTxt('') : httpFailure(500)),
      { ttlMs: 1000, failureTtlMs: 100, maxStaleMs: 0 },
    );
    await check('https://example.com/a');
    clock.now = 1000;
    await expect(check('https://example.com/a')).resolves.toMatchObject({ reason: 'unreachable' });
    clock.now = 1099;
    await check('https://example.com/a');
    expect(calls).toHaveLength(2);
    clock.now = 1100;
    await check('https://example.com/a');
    expect(calls).toHaveLength(3);
  });

  it('bounds the cache as an LRU of maxOrigins origins', async () => {
    const { calls, check } = harness(() => robotsTxt(''), { maxOrigins: 2 });
    await check('https://a.example/1');
    await check('https://b.example/1');
    await check('https://a.example/2'); // a becomes most recently used
    await check('https://c.example/1'); // evicts b
    expect(calls).toHaveLength(3);
    await check('https://a.example/3');
    expect(calls).toHaveLength(3);
    await check('https://b.example/2');
    expect(calls.map((call) => call.url)).toEqual([
      'https://a.example/robots.txt',
      'https://b.example/robots.txt',
      'https://c.example/robots.txt',
      'https://b.example/robots.txt',
    ]);
  });

  it('shares one request between concurrent checks of an origin', async () => {
    let release: (value: SafeFetchResult) => void = () => undefined;
    const { calls, check } = harness(
      () => new Promise<SafeFetchResult>((resolve) => (release = resolve)),
    );
    const first = check('https://example.com/a');
    const second = check('https://example.com/b');
    await Promise.resolve();
    release(robotsTxt('User-agent: *\nDisallow: /b'));
    await expect(first).resolves.toMatchObject({ allowed: true });
    await expect(second).resolves.toMatchObject({ allowed: false });
    expect(calls).toHaveLength(1);
  });

  it('allows everything after too many redirects and disallows an oversized robots.txt', async () => {
    const redirects = harness(() => failure('FEED_TOO_MANY_REDIRECTS'));
    await expect(redirects.check('https://example.com/a')).resolves.toMatchObject({
      allowed: true,
    });
    const large = harness(() => failure('FEED_TOO_LARGE'));
    await expect(large.check('https://example.com/a')).resolves.toMatchObject({
      allowed: false,
      reason: 'disallowed',
    });
  });

  it('treats a non-2xx success as unavailable and a malformed result as unreachable', async () => {
    const notModified = harness(() => ({
      ...robotsTxt('User-agent: *\nDisallow: /'),
      status: 304,
    }));
    await expect(notModified.check('https://example.com/a')).resolves.toMatchObject({
      allowed: true,
    });

    const malformed = harness(() => ({
      ...robotsTxt(''),
      bodyBytes: null as unknown as Uint8Array,
    }));
    await expect(malformed.check('https://example.com/a')).resolves.toEqual({
      allowed: false,
      reason: 'unreachable',
    });

    const other = harness(() => robotsTxt(''));
    await expect(other.check('ftp://example.com/a')).resolves.toEqual({
      allowed: false,
      reason: 'disallowed',
    });
    expect(other.calls).toHaveLength(0);
  });

  it('rejects with a rejected fetch (an infrastructure failure) and caches nothing', async () => {
    const outage = new Error('origin limiter unavailable');
    let down = true;
    const robots = harness(() => {
      if (down) throw outage;
      return robotsTxt(RULES);
    });
    // Concurrent checks of the origin share the one request, and its rejection.
    const settled = await Promise.allSettled([
      robots.check('https://example.com/members/a'),
      robots.check('https://example.com/b'),
    ]);
    expect(settled).toEqual([
      { status: 'rejected', reason: outage },
      { status: 'rejected', reason: outage },
    ]);
    expect(robots.calls).toHaveLength(1);

    // No cached `unreachable`: the retry, well within the 5-minute failure TTL, asks again.
    down = false;
    robots.clock.now += 30_000;
    await expect(robots.check('https://example.com/members/a')).resolves.toEqual({
      allowed: false,
      reason: 'disallowed',
    });
    expect(robots.calls).toHaveLength(2);
  });

  it('leaves a stale cached rule set as it was when its refresh rejects', async () => {
    let down = false;
    const robots = harness(() => {
      if (down) throw new Error('origin limiter unavailable');
      return robotsTxt(RULES);
    });
    await expect(robots.check('https://example.com/b')).resolves.toMatchObject({ allowed: true });
    down = true;
    robots.clock.now += 25 * HOUR; // stale, but usable while robots.txt is unreachable
    await expect(robots.check('https://example.com/b')).rejects.toThrow('origin limiter');
    down = false;
    await expect(robots.check('https://example.com/members/a')).resolves.toMatchObject({
      allowed: false,
      reason: 'disallowed',
    });
    expect(robots.calls).toHaveLength(3);
  });
});
