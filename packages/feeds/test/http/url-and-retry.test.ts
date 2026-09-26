import { describe, expect, it } from 'vitest';

import { ALLOWED_PORTS, SPECIAL_PURPOSE_RANGES } from '../../src/http/address.js';
import { MAX_RETRY_AFTER_MS, parseRetryAfter } from '../../src/http/retry-after.js';
import {
  checkRequestUrl,
  effectivePort,
  MAX_URL_BYTES,
  originOf,
  parseUrl,
  redactUrl,
  requestKey,
  sameRequestUrl,
} from '../../src/http/url.js';

const NOW = Date.UTC(2026, 8, 26, 12, 0, 0);

describe('spec 03 §8.2 originOf: the limiter key scheme://host:port', () => {
  it.each([
    ['https://example.com/feed', 'https://example.com:443'],
    ['https://example.com:443/feed?x=1', 'https://example.com:443'],
    ['http://Example.COM/', 'http://example.com:80'],
    ['http://example.com:8080/a', 'http://example.com:8080'],
    ['https://example.com:8443/', 'https://example.com:8443'],
    ['http://[2001:db8::1]/', 'http://[2001:db8::1]:80'],
    ['http://93.184.216.34:80/', 'http://93.184.216.34:80'],
    ['http://bücher.example/', 'http://xn--bcher-kva.example:80'],
  ])('%s → %s', (url, origin) => {
    expect(originOf(new URL(url))).toBe(origin);
  });

  it('effectivePort uses the scheme default', () => {
    expect(effectivePort(new URL('http://a.example/'))).toBe(80);
    expect(effectivePort(new URL('https://a.example/'))).toBe(443);
    expect(effectivePort(new URL('https://a.example:8080/'))).toBe(8080);
  });
});

describe('spec 03 §4.1 URL checks', () => {
  it('ports: only 80, 443, 8080 and 8443', () => {
    expect(ALLOWED_PORTS).toEqual([80, 443, 8080, 8443]);
    expect(Object.isFrozen(ALLOWED_PORTS)).toBe(true);
    expect(checkRequestUrl(new URL('http://a.example:81/'), false)).toMatchObject({
      ok: false,
      code: 'FEED_BLOCKED_ADDRESS',
    });
    expect(checkRequestUrl(new URL('http://a.example:81/'), true)).toEqual({ ok: true });
    expect(checkRequestUrl(new URL('http://127.0.0.1/'), true)).toEqual({ ok: true });
  });

  it('allowPrivate never relaxes the scheme, userinfo or length rules', () => {
    for (const url of [
      'ftp://a.example/',
      'http://u:p@a.example/',
      `http://a.example/${'a'.repeat(MAX_URL_BYTES)}`,
    ]) {
      expect(checkRequestUrl(new URL(url), true)).toMatchObject({ code: 'FEED_INVALID_URL' });
    }
  });

  it('parseUrl never throws and resolves relative references', () => {
    expect(parseUrl('feed', new URL('http://a.example/x/y'))).toMatchObject({
      ok: true,
      url: new URL('http://a.example/x/feed'),
    });
    expect(parseUrl(undefined)).toMatchObject({ ok: false });
    expect(parseUrl('http://[::1')).toMatchObject({ ok: false });
    expect(parseUrl(`http://a.example/${'a'.repeat(MAX_URL_BYTES)}`)).toMatchObject({ ok: false });
  });

  it('requestKey ignores the fragment, which is never sent', () => {
    expect(requestKey(new URL('http://a.example/x?y=1#top'))).toBe('http://a.example/x?y=1');
    expect(requestKey(new URL('http://a.example/x#'))).toBe('http://a.example/x');
  });

  it('sameRequestUrl compares request identities: the fragment is ignored, nothing else', () => {
    expect(sameRequestUrl('https://a.example/feed', 'https://a.example/feed#top')).toBe(true);
    expect(sameRequestUrl('https://A.example:443/feed', 'https://a.example/feed')).toBe(true);
    expect(sameRequestUrl('https://a.example', 'https://a.example/')).toBe(true);
    expect(sameRequestUrl('https://a.example/feed?x=1', 'https://a.example/feed')).toBe(false);
    expect(sameRequestUrl('http://a.example/feed', 'https://a.example/feed')).toBe(false);
    expect(sameRequestUrl('https://a.example/Feed', 'https://a.example/feed')).toBe(false);
    expect(sameRequestUrl('not a url', 'not a url')).toBe(false);
  });

  it('redactUrl never exposes queries, fragments or credentials (log-safe)', () => {
    expect(redactUrl('https://a.example/feed?token=s3cret#x')).toBe('https://a.example/feed?…#…');
    expect(redactUrl(new URL('http://user:pw@a.example:8080/p'))).toBe('http://…@a.example:8080/p');
    expect(redactUrl('https://a.example/plain')).toBe('https://a.example/plain');
    expect(redactUrl('not a url?token=s3cret')).toBe('[invalid URL]');
  });
});

describe('spec 03 §4.2 the pinned special-purpose table', () => {
  it('parses, is frozen, and contains every range the spec lists', () => {
    const cidrs = [...SPECIAL_PURPOSE_RANGES.ipv4, ...SPECIAL_PURPOSE_RANGES.ipv6].map(
      (r) => r.cidr,
    );
    for (const cidr of [
      '0.0.0.0/8',
      '10.0.0.0/8',
      '100.64.0.0/10',
      '127.0.0.0/8',
      '169.254.0.0/16',
      '172.16.0.0/12',
      '192.0.0.0/24',
      '192.0.2.0/24',
      '192.88.99.0/24',
      '192.168.0.0/16',
      '198.18.0.0/15',
      '198.51.100.0/24',
      '203.0.113.0/24',
      '224.0.0.0/4',
      '240.0.0.0/4',
      '::/128',
      '::1/128',
      'fc00::/7',
      'fe80::/10',
      'ff00::/8',
      '64:ff9b::/96',
      '64:ff9b:1::/48',
      '2001:db8::/32',
      '2002::/16',
      '2001::/32',
    ]) {
      expect(cidrs).toContain(cidr);
    }
    expect(Object.isFrozen(SPECIAL_PURPOSE_RANGES.ipv4)).toBe(true);
    expect(Object.isFrozen(SPECIAL_PURPOSE_RANGES.ipv6)).toBe(true);
    // IPv4-mapped addresses are judged by their embedded IPv4 address, not blocked wholesale.
    expect(cidrs).not.toContain('::ffff:0:0/96');
  });
});

describe('spec 03 §8.2 parseRetryAfter', () => {
  it.each([
    ['120', NOW + 120_000],
    [' 5 ', NOW + 5_000],
    ['0', NOW],
    ['Sat, 26 Sep 2026 13:30:00 GMT', Date.UTC(2026, 8, 26, 13, 30, 0)],
    ['sat, 26 sep 2026 13:30:00 gmt', Date.UTC(2026, 8, 26, 13, 30, 0)],
    ['Saturday, 26-Sep-26 12:10:00 GMT', Date.UTC(2026, 8, 26, 12, 10, 0)],
    ['Sat Sep 26 12:20:00 2026', Date.UTC(2026, 8, 26, 12, 20, 0)],
    ['Sat Sep  6 12:20:00 2026', NOW],
    ['Sat, 26 Sep 2026 23:59:60 GMT', Date.UTC(2026, 8, 26, 23, 59, 59)],
  ])('%j → a valid instant', (value, expected) => {
    expect(parseRetryAfter(value, NOW)?.getTime()).toBe(expected);
  });

  it('a date in the past means now', () => {
    expect(parseRetryAfter('Sun, 06 Nov 1994 08:49:37 GMT', NOW)?.getTime()).toBe(NOW);
    expect(parseRetryAfter('Sunday, 06-Nov-94 08:49:37 GMT', NOW)?.getTime()).toBe(NOW);
  });

  it('clamps to 24 hours', () => {
    expect(parseRetryAfter('999999', NOW)?.getTime()).toBe(NOW + MAX_RETRY_AFTER_MS);
    expect(parseRetryAfter('9'.repeat(400), NOW)?.getTime()).toBe(NOW + MAX_RETRY_AFTER_MS);
    expect(parseRetryAfter('Fri, 01 Jan 2100 00:00:00 GMT', NOW)?.getTime()).toBe(
      NOW + MAX_RETRY_AFTER_MS,
    );
    expect(MAX_RETRY_AFTER_MS).toBe(86_400_000);
  });

  it.each([
    undefined,
    '',
    '   ',
    '-5',
    '1.5',
    '+10',
    '10s',
    'soon',
    'Sat, 31 Feb 2026 10:00:00 GMT',
    'Sat, 26 Foo 2026 10:00:00 GMT',
    'Sat, 26 Sep 2026 25:00:00 GMT',
    'Sat, 26 Sep 2026 10:00:00 CEST',
    '2026-09-26T13:00:00Z',
  ])('%j is invalid → undefined', (value) => {
    expect(parseRetryAfter(value, NOW)).toBeUndefined();
  });

  it('an invalid clock gives undefined', () => {
    expect(parseRetryAfter('10', Number.NaN)).toBeUndefined();
  });
});
