import { sha256Hex } from '@bantoozi/shared/server';
import { describe, expect, it } from 'vitest';

import type { CanonicalizeFailureReason } from '../../src/canonical/index.js';
import { canonicalizeUrl, MAX_PLAIN_URL_KEY_BYTES, urlKey } from '../../src/canonical/index.js';

interface AcceptedCase {
  name: string;
  input: string;
  base?: string;
  expected: string;
}

interface RejectedCase {
  name: string;
  input: string;
  base?: string;
  reason: CanonicalizeFailureReason;
}

const GOOGLE_NEWS_ARTICLE =
  'https://news.google.com/rss/articles/CBMiX0FVX3lxTFBaT0ZCN1ZtR2h4cFdLQ0l3VjJYc0hLZ1N0Q3VxNVNfdmVfRkRzWmFQN0VaWGJNLVNvX2VOdzRqV2V3aU1nZkY5b2tMaWNtUVdwd0VJ0gFkQVVfeXFMTg';

/** spec 03 §5: each input with the canonical URL it must produce. */
const ACCEPTED: readonly AcceptedCase[] = [
  // Step 2: scheme, host and port.
  {
    name: 'lower-cases the scheme and host but keeps the path case',
    input: 'HTTPS://WWW.Example.COM/News/Article-42',
    expected: 'https://www.example.com/News/Article-42',
  },
  {
    name: 'adds the root path to an empty path',
    input: 'https://example.com',
    expected: 'https://example.com/',
  },
  {
    name: 'decodes percent-encoded host characters before lower-casing',
    input: 'https://ex%41mple.com/a',
    expected: 'https://example.com/a',
  },
  {
    name: 'keeps a www host (not provably equivalent to the apex)',
    input: 'https://www.example.com/a',
    expected: 'https://www.example.com/a',
  },
  {
    name: 'converts an IDN host to punycode',
    input: 'https://bücher.example/',
    expected: 'https://xn--bcher-kva.example/',
  },
  {
    name: 'maps an upper-case IDN host to the same punycode',
    input: 'https://BÜCHER.example/katalog',
    expected: 'https://xn--bcher-kva.example/katalog',
  },
  {
    name: 'keeps a punycode host',
    input: 'https://xn--bcher-kva.example/',
    expected: 'https://xn--bcher-kva.example/',
  },
  {
    name: 'converts a Czech IDN host',
    input: 'https://čeština.example/',
    expected: 'https://xn--etina-gya30d.example/',
  },
  {
    name: 'converts a Slovak IDN host',
    input: 'https://ďakujem.sk/',
    expected: 'https://xn--akujem-v2a.sk/',
  },
  {
    name: 'converts a Slovak IDN host and percent-encodes its Slovak path as UTF-8',
    input: 'https://žltý-kôň.sk/články/ďakujem',
    expected: 'https://xn--lt-k-yqa5c77awn.sk/%C4%8Dl%C3%A1nky/%C4%8Fakujem',
  },
  {
    name: 'maps full-width host characters to ASCII (UTS 46)',
    input: 'https://ｅｘａｍｐｌｅ.com/',
    expected: 'https://example.com/',
  },
  {
    name: 'lower-cases and compresses an IPv6 host',
    input: 'http://[2001:DB8:0:0::1]:8080/a',
    expected: 'http://[2001:db8::1]:8080/a',
  },
  {
    name: 'strips the root dot of a fully qualified host',
    input: 'https://example.com./a',
    expected: 'https://example.com/a',
  },
  {
    name: 'strips the root dot of an IDN host',
    input: 'https://bücher.example./',
    expected: 'https://xn--bcher-kva.example/',
  },
  {
    name: 'strips the root dot before a non-default port',
    input: 'https://Example.COM.:8443/a',
    expected: 'https://example.com:8443/a',
  },
  {
    name: 'keeps a host ending in an empty label (two dots)',
    input: 'https://example.com../a',
    expected: 'https://example.com../a',
  },
  {
    name: 'drops the default HTTPS port',
    input: 'https://example.com:443/a',
    expected: 'https://example.com/a',
  },
  {
    name: 'drops the default HTTP port',
    input: 'http://example.com:80/a',
    expected: 'http://example.com/a',
  },
  {
    name: 'drops a zero-padded default port',
    input: 'https://example.com:0443/a',
    expected: 'https://example.com/a',
  },
  {
    name: 'keeps a non-default port',
    input: 'https://example.com:8443/a',
    expected: 'https://example.com:8443/a',
  },
  {
    name: 'keeps port 443 on HTTP',
    input: 'http://example.com:443/a',
    expected: 'http://example.com:443/a',
  },
  {
    name: 'keeps port 80 on HTTPS',
    input: 'https://example.com:80/a',
    expected: 'https://example.com:80/a',
  },
  {
    name: 'keeps an HTTP URL on HTTP',
    input: 'http://example.com/a',
    expected: 'http://example.com/a',
  },
  {
    name: 'keeps an HTTPS URL on HTTPS',
    input: 'https://example.com/a',
    expected: 'https://example.com/a',
  },
  {
    name: 'accepts an empty userinfo, which carries no credentials',
    input: 'https://@example.com/a',
    expected: 'https://example.com/a',
  },
  // Steps 4-5: query.
  {
    name: 'keeps repeated keys',
    input: 'https://example.com/search?a=1&a=2',
    expected: 'https://example.com/search?a=1&a=2',
  },
  {
    name: 'keeps the parameter order',
    input: 'https://example.com/list?b=2&a=1',
    expected: 'https://example.com/list?b=2&a=1',
  },
  {
    name: 'keeps the raw encoding of %2F, + and %20 and the case of escapes',
    input: 'https://example.com/s?q=a%2Fb+c%20d&r=%2f',
    expected: 'https://example.com/s?q=a%2Fb+c%20d&r=%2f',
  },
  {
    name: 'keeps empty values and valueless keys',
    input: 'https://example.com/a?x=&flag&y=1',
    expected: 'https://example.com/a?x=&flag&y=1',
  },
  {
    name: 'keeps empty pairs',
    input: 'https://example.com/a?a=1&&b=2',
    expected: 'https://example.com/a?a=1&&b=2',
  },
  {
    name: 'percent-encodes raw query characters only as WHATWG does',
    input: 'https://example.com/a?q=č ž',
    expected: 'https://example.com/a?q=%C4%8D%20%C5%BE',
  },
  {
    name: 'keeps a query that itself starts with ?',
    input: 'https://example.com/??a=1&utm_source=x',
    expected: 'https://example.com/??a=1',
  },
  {
    name: 'drops an empty ?',
    input: 'https://example.com/a?',
    expected: 'https://example.com/a',
  },
  {
    name: 'drops an empty ? followed by an empty fragment',
    input: 'https://example.com/a?#',
    expected: 'https://example.com/a',
  },
  {
    name: 'never strips id, page, ref or source',
    input: 'https://example.com/a?id=7&page=2&ref=home&source=rss',
    expected: 'https://example.com/a?id=7&page=2&ref=home&source=rss',
  },
  {
    name: 'removes utm_ parameters and the ? they leave empty',
    input: 'https://example.com/a?utm_source=rss&utm_medium=feed&utm_campaign=daily',
    expected: 'https://example.com/a',
  },
  {
    name: 'removes mixed-case UTM_Source and Utm_Medium',
    input: 'https://example.com/a?UTM_Source=x&Utm_Medium=y&id=1',
    expected: 'https://example.com/a?id=1',
  },
  {
    name: 'removes a tracking parameter between ordinary ones',
    input: 'https://example.com/a?a=1&fbclid=IwAR0abc&b=2',
    expected: 'https://example.com/a?a=1&b=2',
  },
  {
    name: 'removes tracking parameters around an ordinary one',
    input: 'https://example.com/a?gclid=Cj0K&a=1&utm_term=x',
    expected: 'https://example.com/a?a=1',
  },
  {
    name: 'decides by the percent-decoded name',
    input: 'https://example.com/a?utm%5Fsource=x&%66bclid=y&a=1',
    expected: 'https://example.com/a?a=1',
  },
  {
    name: 'removes valueless and empty-valued tracking parameters',
    input: 'https://example.com/a?fbclid&a=1&utm_source=',
    expected: 'https://example.com/a?a=1',
  },
  {
    name: 'keeps pairs whose name does not percent-decode',
    input: 'https://example.com/a?%E0%A4%A=1&%ZZ=2&utm_source=x',
    expected: 'https://example.com/a?%E0%A4%A=1&%ZZ=2',
  },
  {
    name: 'matches exact tracking names case-sensitively',
    input: 'https://example.com/a?FBCLID=1&Gclid=2',
    expected: 'https://example.com/a?FBCLID=1&Gclid=2',
  },
  {
    name: 'keeps names that only resemble tracking parameters',
    input: 'https://example.com/a?utm=1&utmsource=2&xutm_source=3&fbclid_=4&ref_srcs=5',
    expected: 'https://example.com/a?utm=1&utmsource=2&xutm_source=3&fbclid_=4&ref_srcs=5',
  },
  {
    name: 'keeps ref while removing ref_src and ref_url',
    input: 'https://example.com/a?ref=feed&ref_src=twsrc&ref_url=x',
    expected: 'https://example.com/a?ref=feed',
  },
  // Step 6: path.
  {
    name: 'keeps repeated slashes',
    input: 'https://example.com//a///b',
    expected: 'https://example.com//a///b',
  },
  {
    name: 'keeps a trailing slash',
    input: 'https://example.com/a/',
    expected: 'https://example.com/a/',
  },
  {
    name: 'keeps percent-encoded reserved characters and their case',
    input: 'https://example.com/a%2Fb/%2f%3F',
    expected: 'https://example.com/a%2Fb/%2f%3F',
  },
  {
    name: 'does not decode percent-encoded unreserved characters',
    input: 'https://example.com/%7Euser/%41',
    expected: 'https://example.com/%7Euser/%41',
  },
  {
    name: 'resolves dot segments (WHATWG)',
    input: 'https://example.com/a/./b/../c',
    expected: 'https://example.com/a/c',
  },
  {
    name: 'turns backslashes into slashes (WHATWG special scheme)',
    input: 'https://example.com\\a\\b',
    expected: 'https://example.com/a/b',
  },
  // Step 3: fragment.
  {
    name: 'removes a fragment',
    input: 'https://example.com/a#section-2',
    expected: 'https://example.com/a',
  },
  {
    name: 'removes a fragment after a query',
    input: 'https://example.com/a?x=1#top',
    expected: 'https://example.com/a?x=1',
  },
  {
    name: 'keeps a hash-bang fragment',
    input: 'https://example.com/#!/story/42',
    expected: 'https://example.com/#!/story/42',
  },
  {
    name: 'keeps a hash-bang fragment after a query',
    input: 'https://example.com/app?lang=sk#!/clanok/42',
    expected: 'https://example.com/app?lang=sk#!/clanok/42',
  },
  {
    name: 'keeps a hash-bang fragment verbatim, tracking-like text included',
    input: 'https://example.com/#!/a?utm_source=x&fbclid=y',
    expected: 'https://example.com/#!/a?utm_source=x&fbclid=y',
  },
  {
    name: 'keeps a bare hash-bang',
    input: 'https://example.com/#!',
    expected: 'https://example.com/#!',
  },
  {
    name: 'removes query tracking parameters but keeps the hash-bang',
    input: 'https://example.com/?utm_source=x&p=1#!/a',
    expected: 'https://example.com/?p=1#!/a',
  },
  // Step 7: AMP and Google News are left to redirects and rel=canonical.
  {
    name: 'leaves an AMP path unchanged',
    input: 'https://www.example.com/2026/09/25/story/amp/',
    expected: 'https://www.example.com/2026/09/25/story/amp/',
  },
  {
    name: 'leaves an AMP query flag unchanged',
    input: 'https://www.example.com/story?amp=1&outputType=amp',
    expected: 'https://www.example.com/story?amp=1&outputType=amp',
  },
  {
    name: 'leaves an .amp.html page unchanged',
    input: 'https://www.example.com/story.amp.html',
    expected: 'https://www.example.com/story.amp.html',
  },
  {
    name: 'leaves an AMP cache URL unchanged',
    input: 'https://www-example-com.cdn.ampproject.org/c/s/www.example.com/story/amp/',
    expected: 'https://www-example-com.cdn.ampproject.org/c/s/www.example.com/story/amp/',
  },
  {
    name: 'leaves a Google News wrapper unchanged',
    input: `${GOOGLE_NEWS_ARTICLE}?oc=5`,
    expected: `${GOOGLE_NEWS_ARTICLE}?oc=5`,
  },
  {
    name: 'removes only tracking parameters and the fragment from a Google News wrapper',
    input: `${GOOGLE_NEWS_ARTICLE}?oc=5&utm_source=feed&hl=sk&gl=SK&ceid=SK:sk#x`,
    expected: `${GOOGLE_NEWS_ARTICLE}?oc=5&hl=sk&gl=SK&ceid=SK:sk`,
  },
  // Step 1: relative input.
  {
    name: 'resolves an absolute path against the feed URL',
    input: '/a/b?utm_source=x#c',
    base: 'https://Example.com/feed.xml',
    expected: 'https://example.com/a/b',
  },
  {
    name: 'resolves dot segments against the base',
    input: '../c',
    base: 'https://example.com/a/b/feed',
    expected: 'https://example.com/a/c',
  },
  {
    name: 'takes the scheme of the base for a protocol-relative URL',
    input: '//cdn.example.com/x',
    base: 'http://example.com/',
    expected: 'http://cdn.example.com/x',
  },
  {
    name: 'resolves a query-only reference',
    input: '?p=2&utm_medium=rss',
    base: 'https://example.com/blog/',
    expected: 'https://example.com/blog/?p=2',
  },
  {
    name: 'resolves a fragment-only reference to the base without its fragment',
    input: '#comments',
    base: 'https://example.com/a?id=1',
    expected: 'https://example.com/a?id=1',
  },
  {
    name: 'ignores the base for absolute input',
    input: 'http://other.example/x',
    base: 'https://example.com/',
    expected: 'http://other.example/x',
  },
  {
    name: 'trims surrounding whitespace (WHATWG)',
    input: '  https://example.com/a\n',
    expected: 'https://example.com/a',
  },
];

/** spec 03 §5 step 1: inputs that never yield an identity. */
const REJECTED: readonly RejectedCase[] = [
  { name: 'javascript:', input: 'javascript:alert(1)', reason: 'unsupported_scheme' },
  {
    name: 'javascript: with an http base',
    input: 'javascript:alert(1)',
    base: 'https://example.com/',
    reason: 'unsupported_scheme',
  },
  { name: 'mailto:', input: 'mailto:news@example.com', reason: 'unsupported_scheme' },
  { name: 'ftp:', input: 'ftp://example.com/file.txt', reason: 'unsupported_scheme' },
  { name: 'data:', input: 'data:text/html,<p>hi</p>', reason: 'unsupported_scheme' },
  { name: 'file:', input: 'file:///etc/passwd', reason: 'unsupported_scheme' },
  { name: 'ws:', input: 'ws://example.com/socket', reason: 'unsupported_scheme' },
  {
    name: 'a relative URL against an ftp: base',
    input: '/a',
    base: 'ftp://example.com/',
    reason: 'unsupported_scheme',
  },
  { name: 'garbage', input: 'not a url', reason: 'invalid_url' },
  { name: 'an empty string', input: '', reason: 'invalid_url' },
  { name: 'a scheme without a host', input: 'https://', reason: 'invalid_url' },
  { name: 'a space in the host', input: 'http://exa mple.com/', reason: 'invalid_url' },
  { name: 'an unterminated IPv6 host', input: 'https://[::1', reason: 'invalid_url' },
  { name: 'an out-of-range port', input: 'https://example.com:99999/', reason: 'invalid_url' },
  { name: 'a relative URL without a base', input: '/relative/path', reason: 'invalid_url' },
  {
    name: 'an unparsable base (WHATWG)',
    input: 'https://example.com/a',
    base: 'garbage',
    reason: 'invalid_url',
  },
  { name: 'a host that is only the root dot', input: 'https://./a', reason: 'invalid_url' },
  { name: 'user and password', input: 'https://user:pass@example.com/', reason: 'credentials' },
  { name: 'a user name only', input: 'https://user@example.com/a', reason: 'credentials' },
  { name: 'a password only', input: 'https://:secret@example.com/a', reason: 'credentials' },
  {
    name: 'credentials inherited from the base',
    input: '/a',
    base: 'https://u:p@example.com/feed',
    reason: 'credentials',
  },
];

/** spec 03 §5 step 7 and §13: distinct URLs never share a key without further evidence. */
const DISTINCT: readonly (readonly [label: string, a: string, b: string])[] = [
  ['HTTP and HTTPS', 'http://example.com/a', 'https://example.com/a'],
  ['a www host and its apex', 'https://www.example.com/a', 'https://example.com/a'],
  ['a trailing slash', 'https://example.com/a', 'https://example.com/a/'],
  ['repeated path slashes', 'https://example.com/a/b', 'https://example.com/a//b'],
  ['path case', 'https://example.com/Article', 'https://example.com/article'],
  ['an encoded slash', 'https://example.com/a%2Fb', 'https://example.com/a/b'],
  ['a reordered query', 'https://example.com/a?b=2&a=1', 'https://example.com/a?a=1&b=2'],
  ['signed query encodings', 'https://example.com/a?sig=a%2Bb', 'https://example.com/a?sig=a+b'],
  ['a repeated key', 'https://example.com/a?a=1', 'https://example.com/a?a=1&a=1'],
  ['a non-default port', 'https://example.com/a', 'https://example.com:8443/a'],
  ['AMP and non-AMP pages', 'https://example.com/story', 'https://example.com/story/amp/'],
  ['hash-bang routes', 'https://example.com/#!/a', 'https://example.com/#!/b'],
  ['different id values', 'https://example.com/a?id=1', 'https://example.com/a?id=2'],
];

/** spec 03 §5 steps 2-4: provably equivalent spellings share one key. */
const EQUIVALENT: readonly (readonly [label: string, a: string, b: string])[] = [
  ['Unicode and punycode hosts', 'https://čeština.example/a', 'https://xn--etina-gya30d.example/a'],
  ['host case and a root dot', 'https://EXAMPLE.com./a', 'https://example.com/a'],
  ['an explicit default port', 'https://example.com:443/a', 'https://example.com/a'],
  ['different fragments', 'https://example.com/a#intro', 'https://example.com/a#comments'],
  [
    'different tracking parameters',
    'https://example.com/a?id=1&utm_source=x',
    'https://example.com/a?fbclid=y&id=1&_ga=2',
  ],
];

function canonical(input: string, base?: string): string {
  const result = canonicalizeUrl(input, base);
  if (!result.ok) throw new Error(`expected ${input} to canonicalize, got ${result.reason}`);
  return result.url;
}

describe('canonicalizeUrl (spec 03 §5)', () => {
  it.each(ACCEPTED)('$name', ({ input, base, expected }) => {
    expect(canonicalizeUrl(input, base)).toEqual({ ok: true, url: expected });
  });

  it.each(REJECTED)('rejects $name', ({ input, base, reason }) => {
    expect(canonicalizeUrl(input, base)).toEqual({ ok: false, reason });
  });

  it.each(DISTINCT)('keeps %s distinct', (_label, a, b) => {
    expect(urlKey(canonical(a))).not.toBe(urlKey(canonical(b)));
  });

  it.each(EQUIVALENT)('gives %s one key', (_label, a, b) => {
    expect(urlKey(canonical(a))).toBe(urlKey(canonical(b)));
  });

  it('returns a fixed point: every canonical URL canonicalizes to itself', () => {
    for (const { expected } of ACCEPTED) {
      expect(canonicalizeUrl(expected)).toEqual({ ok: true, url: expected });
    }
  });
});

describe('urlKey (spec 03 §5 step 7)', () => {
  it('is the canonical URL itself, scheme included', () => {
    for (const { expected } of ACCEPTED) {
      expect(urlKey(expected)).toBe(expected);
    }
    expect(urlKey('http://example.com/a')).toBe('http://example.com/a');
  });

  it('hashes a canonical URL longer than 2,048 UTF-8 bytes (D-11)', () => {
    const prefix = 'https://example.com/?q=';
    const atLimit = prefix + 'a'.repeat(MAX_PLAIN_URL_KEY_BYTES - prefix.length);
    expect(urlKey(atLimit)).toBe(atLimit);
    const over = `${atLimit}b`;
    expect(urlKey(over)).toBe(`sha256:${sha256Hex(over)}`);
    expect(urlKey(over)).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Counted in bytes, not characters: 1,024 two-byte characters plus the prefix exceed the limit.
    const wide = prefix + 'č'.repeat(1024);
    expect(wide.length).toBeLessThan(MAX_PLAIN_URL_KEY_BYTES);
    expect(urlKey(wide)).toBe(`sha256:${sha256Hex(wide)}`);
    // Distinct overlong URLs keep distinct keys; the key is deterministic.
    expect(urlKey(`${over}c`)).not.toBe(urlKey(over));
    expect(urlKey(over)).toBe(urlKey(over));
  });
});
