import { describe, expect, it } from 'vitest';

import {
  CREDENTIAL_PARAMS,
  MAX_FEED_IDENTITY_BYTES,
  MAX_FEED_URL_BYTES,
  redactFeedUrl,
  validateFeedUrl,
  type FeedUrlRejection,
} from '../../src/discover/index.js';

describe('validateFeedUrl: accepted URLs', () => {
  it.each([
    [
      'plain https',
      'https://example.com/feed',
      'https://example.com/feed',
      'https://example.com/feed',
    ],
    [
      'plain http',
      'http://example.com/rss.xml',
      'http://example.com/rss.xml',
      'http://example.com/rss.xml',
    ],
    [
      'tracking parameters: kept for fetching, dropped from the identity',
      'https://example.com/feed?utm_source=x&id=1&fbclid=abc',
      'https://example.com/feed?utm_source=x&id=1&fbclid=abc',
      'https://example.com/feed?id=1',
    ],
    [
      'a signed query keeps its order and encoding',
      'https://cdn.example/feed.xml?Expires=1&Signature=a%2Fb%3D&Key-Pair-Id=K',
      'https://cdn.example/feed.xml?Expires=1&Signature=a%2Fb%3D&Key-Pair-Id=K',
      'https://cdn.example/feed.xml?Expires=1&Signature=a%2Fb%3D&Key-Pair-Id=K',
    ],
    [
      'case, default port and trailing dot are normalized',
      'HTTPS://Example.COM.:443/Feed',
      'https://example.com./Feed',
      'https://example.com/Feed',
    ],
    [
      'the fragment is never fetched; a hash-bang stays in the identity',
      'https://example.com/app#!/feed',
      'https://example.com/app',
      'https://example.com/app#!/feed',
    ],
    [
      'a plain fragment is dropped',
      'https://example.com/feed#top',
      'https://example.com/feed',
      'https://example.com/feed',
    ],
    [
      'IDN host',
      'https://bücher.example/feed',
      'https://xn--bcher-kva.example/feed',
      'https://xn--bcher-kva.example/feed',
    ],
    [
      'port 8080',
      'http://example.com:8080/feed',
      'http://example.com:8080/feed',
      'http://example.com:8080/feed',
    ],
    [
      'port 8443',
      'https://example.com:8443/feed',
      'https://example.com:8443/feed',
      'https://example.com:8443/feed',
    ],
    [
      'port 443 over http',
      'http://example.com:443/feed',
      'http://example.com:443/feed',
      'http://example.com:443/feed',
    ],
    [
      'port 80 over https',
      'https://example.com:80/feed',
      'https://example.com:80/feed',
      'https://example.com:80/feed',
    ],
    [
      'public IPv4 literal',
      'http://93.184.215.14/feed',
      'http://93.184.215.14/feed',
      'http://93.184.215.14/feed',
    ],
    [
      'public IPv6 literal',
      'http://[2606:4700::1111]/feed',
      'http://[2606:4700::1111]/feed',
      'http://[2606:4700::1111]/feed',
    ],
    [
      'IPv4-mapped public address',
      'http://[::ffff:8.8.8.8]/feed',
      'http://[::ffff:808:808]/feed',
      'http://[::ffff:808:808]/feed',
    ],
    [
      'surrounding whitespace',
      '  https://example.com/feed\n',
      'https://example.com/feed',
      'https://example.com/feed',
    ],
    [
      'parameter names that merely contain a credential word',
      'https://example.com/feed?tokens=1&author=me&auth_mode=x&passwords=0&my_token=2',
      'https://example.com/feed?tokens=1&author=me&auth_mode=x&passwords=0&my_token=2',
      'https://example.com/feed?tokens=1&author=me&auth_mode=x&passwords=0&my_token=2',
    ],
    [
      'an empty userinfo marker',
      'http://@example.com/feed',
      'http://example.com/feed',
      'http://example.com/feed',
    ],
  ])('%s', (_name, input, fetchUrl, canonicalUrl) => {
    expect(validateFeedUrl(input)).toEqual({ ok: true, fetchUrl, canonicalUrl });
  });
});

describe('validateFeedUrl: rejected URLs', () => {
  const cases: Array<[string, string, FeedUrlRejection]> = [
    ['empty', '', 'invalid_url'],
    ['relative', '/feed.xml', 'invalid_url'],
    ['no scheme', 'example.com/feed', 'invalid_url'],
    ['a space in the host', 'http://exa mple.com/', 'invalid_url'],
    ['a zone ID', 'http://[fe80::1%25eth0]/feed', 'invalid_url'],
    ['a host that is only a dot', 'http://./feed', 'invalid_url'],
    ['ftp', 'ftp://example.com/feed', 'unsupported_scheme'],
    ['file', 'file:///etc/passwd', 'unsupported_scheme'],
    ['javascript', 'javascript:alert(1)', 'unsupported_scheme'],
    ['data', 'data:application/rss+xml,<rss/>', 'unsupported_scheme'],
    ['feed pseudo-scheme', 'feed://example.com/rss', 'unsupported_scheme'],
    ['user and password', 'https://alice:secret@example.com/feed', 'credentials'],
    ['user only', 'https://alice@example.com/feed', 'credentials'],
    ['password only', 'https://:secret@example.com/feed', 'credentials'],
    ['token', 'https://example.com/feed?token=abc', 'credential_param'],
    ['access_token', 'https://example.com/feed?x=1&access_token=abc', 'credential_param'],
    ['api_key', 'https://example.com/feed?api_key=abc', 'credential_param'],
    ['auth', 'https://example.com/feed?auth=abc', 'credential_param'],
    ['password', 'https://example.com/feed?password=abc', 'credential_param'],
    ['upper case', 'https://example.com/feed?API_KEY=abc', 'credential_param'],
    ['percent-encoded name', 'https://example.com/feed?%74oken=abc', 'credential_param'],
    ['a name without a value', 'https://example.com/feed?auth', 'credential_param'],
    ['an empty value', 'https://example.com/feed?password=', 'credential_param'],
    ['a semicolon separator', 'https://example.com/feed?a=1;token=abc', 'credential_param'],
    ['an OAuth fragment', 'https://example.com/feed#access_token=abc', 'credential_param'],
    ['a hash-bang query', 'https://example.com/app#!/feed?token=abc', 'credential_param'],
    ['loopback', 'http://127.0.0.1/feed', 'blocked_address'],
    ['loopback, decimal', 'http://2130706433/feed', 'blocked_address'],
    ['loopback, hex', 'http://0x7f.1/feed', 'blocked_address'],
    ['loopback, octal', 'http://0177.0.0.1/feed', 'blocked_address'],
    ['IPv6 loopback', 'http://[::1]/feed', 'blocked_address'],
    ['IPv4-mapped loopback', 'http://[::ffff:127.0.0.1]/feed', 'blocked_address'],
    ['IPv4-compatible loopback', 'http://[::127.0.0.1]/feed', 'blocked_address'],
    ['unspecified', 'http://0.0.0.0/feed', 'blocked_address'],
    ['zero', 'http://0/feed', 'blocked_address'],
    ['10/8', 'http://10.0.0.1/feed', 'blocked_address'],
    ['172.16/12', 'http://172.31.255.255/feed', 'blocked_address'],
    ['192.168/16', 'http://192.168.1.1/feed', 'blocked_address'],
    ['CGN', 'http://100.64.0.1/feed', 'blocked_address'],
    ['link-local / cloud metadata', 'http://169.254.169.254/latest/meta-data', 'blocked_address'],
    ['documentation', 'http://203.0.113.5/feed', 'blocked_address'],
    ['multicast', 'http://224.0.0.1/feed', 'blocked_address'],
    ['unique local IPv6', 'http://[fd00::1]/feed', 'blocked_address'],
    ['link-local IPv6', 'http://[fe80::1]/feed', 'blocked_address'],
    ['NAT64', 'http://[64:ff9b::7f00:1]/feed', 'blocked_address'],
    ['6to4', 'http://[2002:7f00:1::1]/feed', 'blocked_address'],
    ['localhost', 'http://localhost/feed', 'blocked_address'],
    ['localhost with a trailing dot', 'http://localhost./feed', 'blocked_address'],
    ['a localhost subdomain', 'http://app.localhost/feed', 'blocked_address'],
    ['port 22', 'https://example.com:22/feed', 'blocked_address'],
    ['port 3000', 'http://example.com:3000/feed', 'blocked_address'],
    [
      'longer than 8,192 bytes',
      `https://example.com/${'a'.repeat(MAX_FEED_URL_BYTES)}`,
      'too_long',
    ],
    [
      'longer than 8,192 bytes only after percent-encoding',
      `https://example.com/${'č'.repeat(1400)}`,
      'too_long',
    ],
    [
      'a canonical URL longer than 2,048 bytes',
      `https://example.com/${'a'.repeat(MAX_FEED_IDENTITY_BYTES)}`,
      'too_long',
    ],
  ];

  it.each(cases)('%s', (_name, input, reason) => {
    expect(validateFeedUrl(input)).toEqual({ ok: false, reason });
  });

  it('checks the input length before parsing', () => {
    expect(validateFeedUrl(`not a url ${'x'.repeat(MAX_FEED_URL_BYTES)}`)).toEqual({
      ok: false,
      reason: 'too_long',
    });
  });

  it('accepts a canonical URL of exactly 2,048 bytes whose fetch URL is longer', () => {
    const path = 'a'.repeat(MAX_FEED_IDENTITY_BYTES - 'https://example.com/'.length);
    const result = validateFeedUrl(`https://example.com/${path}?utm_source=${'x'.repeat(100)}`);
    expect(result).toMatchObject({ ok: true, canonicalUrl: `https://example.com/${path}` });
  });

  it('lists exactly the credential parameters of spec 03 §4', () => {
    expect(CREDENTIAL_PARAMS).toEqual(['token', 'access_token', 'api_key', 'auth', 'password']);
  });
});

describe('validateFeedUrl with allowPrivate (FETCH_ALLOW_PRIVATE)', () => {
  it.each([
    'http://127.0.0.1:43210/feed.xml',
    'http://[::1]:8081/feed',
    'http://localhost:3000/rss',
    'http://10.0.0.5/feed',
  ])('accepts %s', (input) => {
    expect(validateFeedUrl(input, { allowPrivate: true })).toMatchObject({ ok: true });
  });

  it('still rejects credentials, credential parameters, other schemes and long URLs', () => {
    const options = { allowPrivate: true };
    expect(validateFeedUrl('http://u:p@127.0.0.1/feed', options)).toEqual({
      ok: false,
      reason: 'credentials',
    });
    expect(validateFeedUrl('http://127.0.0.1/feed?token=1', options)).toEqual({
      ok: false,
      reason: 'credential_param',
    });
    expect(validateFeedUrl('gopher://127.0.0.1/', options)).toEqual({
      ok: false,
      reason: 'unsupported_scheme',
    });
    expect(validateFeedUrl(`http://127.0.0.1/${'a'.repeat(3000)}`, options)).toEqual({
      ok: false,
      reason: 'too_long',
    });
  });
});

describe('redactFeedUrl', () => {
  it.each([
    ['https://alice:secret@example.com/feed', 'https://***@example.com/feed'],
    ['https://alice@example.com/feed', 'https://***@example.com/feed'],
    ['https://example.com/feed?a=1&token=abc&b=2', 'https://example.com/feed?a=1&token=***&b=2'],
    ['https://example.com/feed?PassWord=hunter2;x=1', 'https://example.com/feed?PassWord=***;x=1'],
    ['https://example.com/feed?%61uth=abc', 'https://example.com/feed?%61uth=***'],
    [
      'https://example.com/app#!/feed?access_token=abc',
      'https://example.com/app#!/feed?access_token=***',
    ],
    ['https://example.com/feed?id=7', 'https://example.com/feed?id=7'],
    ['  not a url  ', 'not a url'],
  ])('%s → %s', (input, expected) => {
    expect(redactFeedUrl(input)).toBe(expected);
  });

  it('truncates long values to 512 characters', () => {
    const redacted = redactFeedUrl(`https://example.com/${'a'.repeat(1000)}`);
    expect(redacted).toHaveLength(512);
    expect(redacted.endsWith('…')).toBe(true);
  });
});
