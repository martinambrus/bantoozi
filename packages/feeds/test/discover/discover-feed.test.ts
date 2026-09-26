import { describe, expect, it } from 'vitest';

import {
  DISCOVERY_DEADLINE_MS,
  DISCOVERY_MAX_CANDIDATES,
  DISCOVERY_MAX_REQUESTS,
  FEED_PROBE_PATHS,
  discoverFeed,
  type DiscoverResult,
} from '../../src/discover/index.js';

import {
  FakeWeb,
  HTML,
  RSS,
  alternate,
  atom,
  deferred,
  htmlPage,
  jsonFeed,
  rdf,
  rss,
  until,
} from './fake-web.js';

const SITE = 'https://blog.example';

function success(result: DiscoverResult): Extract<DiscoverResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected candidates, got ${result.code}: ${result.message}`);
  return result;
}

describe('discoverFeed: direct feeds', () => {
  it('returns a feed URL as the single, validated candidate', async () => {
    const web = new FakeWeb().route(`${SITE}/feed?utm_source=tw&id=1`, {
      body: rss('  The   Blog '),
      contentType: RSS,
    });
    const result = success(await discoverFeed(`${SITE}/feed?utm_source=tw&id=1`, web.deps()));
    const candidate = {
      url: `${SITE}/feed?utm_source=tw&id=1`,
      canonicalUrl: `${SITE}/feed?id=1`,
      title: 'The Blog',
      type: 'rss',
    };
    expect(result.candidates).toEqual([candidate]);
    expect(result.validated?.candidate).toEqual(candidate);
    expect(result.validated?.parsed).toMatchObject({
      kind: 'rss',
      feed: { title: '  The   Blog ' },
    });
    expect(result.validated?.parsed).not.toHaveProperty('ok');
    expect(web.calls).toEqual([
      {
        url: `${SITE}/feed?utm_source=tw&id=1`,
        options: { purpose: 'discovery', timeoutMs: DISCOVERY_DEADLINE_MS, maxRedirects: 5 },
      },
    ]);
    expect(web.parsed).toEqual([`${SITE}/feed?utm_source=tw&id=1`]);
  });

  it.each([
    ['Atom', atom('Atom title'), 'atom', 'Atom title'],
    ['RSS 1.0', rdf('RDF title'), 'rdf', 'RDF title'],
    ['JSON Feed', jsonFeed('JSON title'), 'json', 'JSON title'],
    ['an untitled RSS feed', rss(null), 'rss', null],
  ])('recognizes %s', async (_name, body, type, title) => {
    const web = new FakeWeb().route(`${SITE}/f`, { body });
    const result = success(await discoverFeed(`${SITE}/f`, web.deps()));
    expect(result.candidates).toEqual([
      { url: `${SITE}/f`, canonicalUrl: `${SITE}/f`, title, type },
    ]);
  });

  it('adopts the final URL only when every redirect was permanent', async () => {
    const web = new FakeWeb()
      .route('http://old.example/rss', {
        body: rss(),
        finalUrl: 'https://new.example/feed?utm_campaign=x',
        permanent: true,
        hops: 2,
      })
      .route('https://temp.example/feed', {
        body: rss(),
        finalUrl: 'https://cdn.example/feed.xml?Expires=1&Signature=abc',
      })
      .route('https://moved.example/feed', {
        body: rss(),
        finalUrl: 'https://moved.example/feed?token=secret',
        permanent: true,
      });
    expect(
      success(await discoverFeed('http://old.example/rss', web.deps())).candidates[0],
    ).toMatchObject({
      url: 'https://new.example/feed?utm_campaign=x',
      canonicalUrl: 'https://new.example/feed',
    });
    expect(
      success(await discoverFeed('https://temp.example/feed', web.deps())).candidates[0],
    ).toMatchObject({
      url: 'https://temp.example/feed',
      canonicalUrl: 'https://temp.example/feed',
    });
    // A permanent destination that fails validation is not adopted.
    expect(
      success(await discoverFeed('https://moved.example/feed', web.deps())).candidates[0],
    ).toMatchObject({
      url: 'https://moved.example/feed',
    });
  });

  it('reports a broken feed as FEED_PARSE_ERROR and other documents as FEED_NOT_A_FEED', async () => {
    const web = new FakeWeb()
      .route(`${SITE}/broken`, { body: '<broken rss', contentType: 'application/xml' })
      .route(`${SITE}/api`, { body: '{"posts": []}', contentType: 'application/json' });
    expect(await discoverFeed(`${SITE}/broken`, web.deps())).toEqual({
      ok: false,
      code: 'FEED_PARSE_ERROR',
      message: 'the feed is malformed',
    });
    expect(await discoverFeed(`${SITE}/api`, web.deps())).toEqual({
      ok: false,
      code: 'FEED_NOT_A_FEED',
      message: 'not a feed',
    });
    // Neither is HTML, so no alternates or probes were requested.
    expect(web.urls()).toEqual([`${SITE}/broken`, `${SITE}/api`]);
  });

  it('reports an undecodable page as FEED_DECODE_ERROR', async () => {
    const web = new FakeWeb().route(`${SITE}/`, { body: '', undecodable: true });
    expect(await discoverFeed(`${SITE}/`, web.deps())).toEqual({
      ok: false,
      code: 'FEED_DECODE_ERROR',
      message: 'the body cannot be decoded',
    });
  });

  it("returns the page's fetch failure with its retryAt", async () => {
    const retryAt = new Date('2026-09-26T12:00:00Z');
    const web = new FakeWeb().route(`${SITE}/feed`, {
      fail: 'FEED_HTTP_429',
      message: 'HTTP 429',
      retryAt,
    });
    expect(await discoverFeed(`${SITE}/feed`, web.deps())).toEqual({
      ok: false,
      code: 'FEED_HTTP_429',
      message: 'HTTP 429',
      retryAt,
    });
  });
});

describe('discoverFeed: input normalization and URL policy', () => {
  it.each([
    ['blog.example/feed', 'https://blog.example/feed'],
    ['  blog.example  ', 'https://blog.example/'],
    ['blog.example:8080/feed', 'https://blog.example:8080/feed'],
    ['//blog.example/feed', 'https://blog.example/feed'],
    ['HTTP://Blog.Example/feed', 'http://blog.example/feed'],
  ])('fetches %s as %s first', async (input, expected) => {
    const web = new FakeWeb().route(expected, { body: rss() });
    success(await discoverFeed(input, web.deps()));
    expect(web.urls()).toEqual([expected]);
  });

  it.each([
    ['', 'FEED_INVALID_URL', 'invalid_url'],
    ['   ', 'FEED_INVALID_URL', 'invalid_url'],
    ['ftp://blog.example/feed', 'FEED_INVALID_URL', 'unsupported_scheme'],
    ['javascript:alert(1)', 'FEED_INVALID_URL', 'unsupported_scheme'],
    ['https://user:pw@blog.example/feed', 'FEED_INVALID_URL', 'credentials'],
    ['user:pw@blog.example/feed', 'FEED_INVALID_URL', 'unsupported_scheme'],
    ['blog.example/feed?token=abc', 'FEED_INVALID_URL', 'credential_param'],
    ['http://exa mple.com/', 'FEED_INVALID_URL', 'invalid_url'],
    [`https://blog.example/${'a'.repeat(9000)}`, 'FEED_INVALID_URL', 'too_long'],
    ['http://127.0.0.1/feed', 'FEED_BLOCKED_ADDRESS', 'blocked_address'],
    ['localhost:3000/feed', 'FEED_BLOCKED_ADDRESS', 'blocked_address'],
    ['[::1]/feed', 'FEED_BLOCKED_ADDRESS', 'blocked_address'],
  ])('rejects %j without any request', async (input, code, reason) => {
    const web = new FakeWeb();
    const result = await discoverFeed(input, web.deps());
    expect(result).toMatchObject({ ok: false, code, reason });
    expect(result.ok || result.message.includes('?')).toBe(false);
    expect(web.calls).toEqual([]);
  });

  it('accepts private destinations with allowPrivate', async () => {
    const web = new FakeWeb().route('http://127.0.0.1:43210/feed.xml', { body: rss() });
    const result = await discoverFeed(
      'http://127.0.0.1:43210/feed.xml',
      web.deps({ allowPrivate: true }),
    );
    expect(success(result).candidates).toHaveLength(1);
  });
});

describe('discoverFeed: HTTPS → HTTP fallback', () => {
  it.each(['FEED_CONNECTION_ERROR', 'FEED_TIMEOUT'])(
    'retries a scheme-less input over http after %s',
    async (code) => {
      const web = new FakeWeb()
        .route('https://blog.example/feed', { fail: code })
        .route('http://blog.example/feed', { body: rss('Plain') });
      const result = success(await discoverFeed('blog.example/feed', web.deps()));
      expect(result.candidates).toEqual([
        {
          url: 'http://blog.example/feed',
          canonicalUrl: 'http://blog.example/feed',
          title: 'Plain',
          type: 'rss',
        },
      ]);
      expect(web.urls()).toEqual(['https://blog.example/feed', 'http://blog.example/feed']);
    },
  );

  it.each([
    'FEED_TLS_ERROR',
    'FEED_BLOCKED_ADDRESS',
    'FEED_DNS_ERROR',
    'FEED_HTTP_404',
    'FEED_TOO_MANY_REDIRECTS',
    'FEED_ORIGIN_COOLDOWN',
  ])('never falls back after %s', async (code) => {
    const web = new FakeWeb()
      .route('https://blog.example/feed', { fail: code, message: 'nope' })
      .route('http://blog.example/feed', { body: rss() });
    expect(await discoverFeed('blog.example/feed', web.deps())).toEqual({
      ok: false,
      code,
      message: 'nope',
    });
    expect(web.urls()).toEqual(['https://blog.example/feed']);
  });

  it('never falls back when the user typed https://', async () => {
    const web = new FakeWeb()
      .route('https://blog.example/feed', { fail: 'FEED_CONNECTION_ERROR' })
      .route('http://blog.example/feed', { body: rss() });
    expect(await discoverFeed('https://blog.example/feed', web.deps())).toMatchObject({
      ok: false,
      code: 'FEED_CONNECTION_ERROR',
    });
    expect(web.urls()).toEqual(['https://blog.example/feed']);
  });

  it('reports the http failure when both attempts fail', async () => {
    const web = new FakeWeb()
      .route('https://blog.example/', { fail: 'FEED_CONNECTION_ERROR' })
      .route('http://blog.example/', { fail: 'FEED_HTTP_500' });
    expect(await discoverFeed('blog.example', web.deps())).toMatchObject({
      ok: false,
      code: 'FEED_HTTP_500',
    });
  });

  it('does not fall back when the deadline is spent', async () => {
    const web = new FakeWeb().route('https://blog.example/', {
      fail: 'FEED_TIMEOUT',
      tookMs: DISCOVERY_DEADLINE_MS,
    });
    expect(await discoverFeed('blog.example', web.deps())).toMatchObject({
      ok: false,
      code: 'FEED_TIMEOUT',
    });
    expect(web.calls).toHaveLength(1);
  });
});

describe('discoverFeed: <link rel="alternate">', () => {
  it('fetches and parses a single alternate before offering it', async () => {
    const web = new FakeWeb()
      .route(`${SITE}/posts/hello`, {
        body: htmlPage(alternate(RSS, '../feed/', 'Blog » Feed')),
        contentType: HTML,
      })
      .route(`${SITE}/feed/`, { body: rss('Blog'), contentType: RSS });
    const result = success(await discoverFeed(`${SITE}/posts/hello`, web.deps()));
    expect(result.candidates).toEqual([
      { url: `${SITE}/feed/`, canonicalUrl: `${SITE}/feed/`, title: 'Blog', type: 'rss' },
    ]);
    expect(result.validated?.candidate).toEqual(result.candidates[0]);
    expect(web.calls.map((call) => [call.url, call.options.purpose])).toEqual([
      [`${SITE}/posts/hello`, 'discovery'],
      [`${SITE}/feed/`, 'feed'],
    ]);
  });

  it("resolves alternates against the page's final URL and uses the link title as fallback", async () => {
    const web = new FakeWeb()
      .route('http://blog.example/', {
        body: htmlPage(alternate(RSS, 'feed.xml', '  Link   title ')),
        contentType: HTML,
        finalUrl: `${SITE}/home/`,
      })
      .route(`${SITE}/home/feed.xml`, { body: rss(null) });
    const result = success(await discoverFeed('http://blog.example/', web.deps()));
    expect(result.candidates).toEqual([
      {
        url: `${SITE}/home/feed.xml`,
        canonicalUrl: `${SITE}/home/feed.xml`,
        title: 'Link title',
        type: 'rss',
      },
    ]);
  });

  it('returns several verified alternates for the user to choose, feed types first', async () => {
    const web = new FakeWeb()
      .route(`${SITE}/`, {
        body: htmlPage(
          alternate('application/json', '/wp-json/wp/v2/pages/2') +
            alternate(RSS, '/feed/', 'Blog » Feed') +
            alternate(RSS, '/comments/feed/', 'Blog » Comments Feed') +
            alternate('application/atom+xml', '/atom.xml') +
            alternate('application/feed+json', '/feed.json'),
        ),
        contentType: HTML,
      })
      .route(`${SITE}/wp-json/wp/v2/pages/2`, {
        body: '{"id": 2}',
        contentType: 'application/json',
      })
      .route(`${SITE}/feed/`, { body: rss('Blog') })
      .route(`${SITE}/comments/feed/`, { body: rss('Comments on Blog') })
      .route(`${SITE}/atom.xml`, { body: atom('Blog (Atom)') })
      .route(`${SITE}/feed.json`, { body: jsonFeed('Blog (JSON)') });
    const result = success(await discoverFeed(`${SITE}/`, web.deps()));
    expect(result.validated).toBeUndefined();
    expect(result.candidates.map(({ url, title, type }) => [url, title, type])).toEqual([
      [`${SITE}/feed/`, 'Blog', 'rss'],
      [`${SITE}/comments/feed/`, 'Comments on Blog', 'rss'],
      [`${SITE}/atom.xml`, 'Blog (Atom)', 'atom'],
      [`${SITE}/feed.json`, 'Blog (JSON)', 'json'],
    ]);
    // The generic JSON link was fetched last and rejected: declaring is not proof.
    expect(web.urls().at(-1)).toBe(`${SITE}/wp-json/wp/v2/pages/2`);
  });

  it('never requests invalid alternates, the page itself or duplicates', async () => {
    const web = new FakeWeb()
      .route(`${SITE}/page`, {
        body: htmlPage(
          [
            alternate(RSS, 'javascript:alert(1)'),
            alternate(RSS, 'ftp://blog.example/feed'),
            alternate(RSS, 'data:application/rss+xml,<rss/>'),
            alternate(RSS, 'https://user:pw@blog.example/feed'),
            alternate(RSS, '/feed?token=abc'),
            alternate(RSS, 'http://127.0.0.1/feed'),
            alternate(RSS, 'http://169.254.169.254/latest/meta-data'),
            alternate(RSS, 'https://blog.example:8081/feed'),
            alternate(RSS, '/page#comments'),
            alternate(RSS, '/feed?utm_source=a'),
            alternate('application/atom+xml', '/feed?utm_source=b'),
            alternate(RSS, 'HTTPS://BLOG.EXAMPLE/feed#top'),
          ].join(''),
        ),
        contentType: HTML,
      })
      .route(`${SITE}/feed?utm_source=a`, { body: rss('Blog') });
    const result = success(await discoverFeed(`${SITE}/page`, web.deps()));
    expect(result.candidates).toEqual([
      {
        url: `${SITE}/feed?utm_source=a`,
        canonicalUrl: `${SITE}/feed`,
        title: 'Blog',
        type: 'rss',
      },
    ]);
    expect(web.urls()).toEqual([`${SITE}/page`, `${SITE}/feed?utm_source=a`]);
  });

  it('merges alternates that permanently redirect to the same feed', async () => {
    const web = new FakeWeb()
      .route(`${SITE}/`, {
        body: htmlPage(alternate(RSS, '/rss') + alternate('application/atom+xml', '/atom')),
        contentType: HTML,
      })
      .route(`${SITE}/rss`, { body: rss('One'), finalUrl: `${SITE}/feed/`, permanent: true })
      .route(`${SITE}/atom`, { body: rss('One'), finalUrl: `${SITE}/feed/`, permanent: true });
    const result = success(await discoverFeed(`${SITE}/`, web.deps()));
    expect(result.candidates).toEqual([
      { url: `${SITE}/feed/`, canonicalUrl: `${SITE}/feed/`, title: 'One', type: 'rss' },
    ]);
    expect(result.validated?.candidate).toEqual(result.candidates[0]);
  });

  it('drops alternates that do not parse and probes when none is a feed', async () => {
    const web = new FakeWeb()
      .route(`${SITE}/`, {
        body: htmlPage(
          alternate(RSS, 'https://feeds.dead.example/blog') +
            alternate(RSS, '/old-feed') +
            alternate(RSS, '/undecodable'),
        ),
        contentType: HTML,
      })
      .route('https://feeds.dead.example/blog', { fail: 'FEED_DNS_ERROR' })
      .route(`${SITE}/old-feed`, { body: htmlPage(), contentType: HTML })
      .route(`${SITE}/undecodable`, { body: '', undecodable: true })
      .route(`${SITE}/rss`, { body: rss('Found by probing') });
    const result = success(await discoverFeed(`${SITE}/`, web.deps()));
    expect(result.candidates).toEqual([
      { url: `${SITE}/rss`, canonicalUrl: `${SITE}/rss`, title: 'Found by probing', type: 'rss' },
    ]);
  });

  it('caps candidates at 20', async () => {
    const links = Array.from({ length: 30 }, (_, i) => alternate(RSS, `/feed-${i}`)).join('');
    const web = new FakeWeb().route(`${SITE}/`, { body: htmlPage(links), contentType: HTML });
    for (let i = 0; i < 30; i += 1) web.route(`${SITE}/feed-${i}`, { body: rss(`Feed ${i}`) });
    const result = success(await discoverFeed(`${SITE}/`, web.deps({ maxRequests: 100 })));
    expect(result.candidates).toHaveLength(DISCOVERY_MAX_CANDIDATES);
    expect(result.candidates.at(-1)?.title).toBe('Feed 19');
    expect(web.calls).toHaveLength(1 + DISCOVERY_MAX_CANDIDATES);
  });
});

describe('discoverFeed: request budget, deadline and concurrency', () => {
  function manyAlternates(count: number, web: FakeWeb, feeds = true): FakeWeb {
    const links = Array.from({ length: count }, (_, i) => alternate(RSS, `/feed-${i}`)).join('');
    web.route(`${SITE}/`, { body: htmlPage(links), contentType: HTML });
    if (feeds)
      for (let i = 0; i < count; i += 1) web.route(`${SITE}/feed-${i}`, { body: rss(`Feed ${i}`) });
    return web;
  }

  it(`sends at most ${DISCOVERY_MAX_REQUESTS} requests`, async () => {
    const web = manyAlternates(12, new FakeWeb());
    const result = success(await discoverFeed(`${SITE}/`, web.deps()));
    expect(web.calls).toHaveLength(DISCOVERY_MAX_REQUESTS);
    expect(result.candidates.map((candidate) => candidate.title)).toEqual(
      Array.from({ length: 9 }, (_, i) => `Feed ${i}`),
    );
    // Each fetch may follow only the redirect hops left in the budget after the hops reserved by
    // the probe running beside it (the page first, then two probes at a time).
    expect(web.calls.map((call) => call.options.maxRedirects)).toEqual([
      5, 5, 2, 4, 1, 3, 0, 2, 1, 0,
    ]);
  });

  it('never lets concurrent probes follow more redirects together than the budget has', async () => {
    const web = manyAlternates(12, new FakeWeb());
    // A worst-case site: every candidate follows as many redirects as it is allowed.
    let followed = 0;
    for (let i = 0; i < 12; i += 1) {
      web.route(`${SITE}/feed-${i}`, (call) => {
        const hops = call.options.maxRedirects ?? 0;
        followed += hops;
        return { body: rss(`Feed ${i}`), finalUrl: `${SITE}/feed-${i}/final`, hops, delayMs: 1 };
      });
    }
    success(await discoverFeed(`${SITE}/`, web.deps()));
    // Requests sent: every fetch plus every redirect hop it followed.
    expect(web.calls.length + followed).toBeLessThanOrEqual(DISCOVERY_MAX_REQUESTS);
    expect(followed).toBeGreaterThan(0);
    expect(web.maxInFlight).toBe(2);
  });

  it('counts redirect hops against the budget', async () => {
    const web = manyAlternates(12, new FakeWeb());
    web.route(`${SITE}/`, {
      body: htmlPage(Array.from({ length: 12 }, (_, i) => alternate(RSS, `/feed-${i}`)).join('')),
      contentType: HTML,
      finalUrl: `${SITE}/`,
      hops: 3,
    });
    const result = success(await discoverFeed(`${SITE}/`, web.deps()));
    expect(web.calls).toHaveLength(1 + 6);
    expect(result.candidates).toHaveLength(6);
  });

  it('reports FEED_NOT_A_FEED when the budget runs out without a feed', async () => {
    const web = manyAlternates(12, new FakeWeb(), false);
    expect(await discoverFeed(`${SITE}/`, web.deps())).toEqual({
      ok: false,
      code: 'FEED_NOT_A_FEED',
      message: `No feed was found within the budget of ${DISCOVERY_MAX_REQUESTS} requests`,
    });
    expect(web.calls).toHaveLength(DISCOVERY_MAX_REQUESTS);
  });

  it('shares one deadline between all requests', async () => {
    const web = new FakeWeb().route(`${SITE}/`, {
      body: htmlPage(),
      contentType: HTML,
      tookMs: 6_000,
    });
    for (const path of FEED_PROBE_PATHS)
      web.route(`${SITE}${path}`, { fail: 'FEED_HTTP_404', tookMs: 6_000 });
    const result = await discoverFeed(`${SITE}/`, web.deps({ maxConcurrentProbes: 1 }));
    expect(web.calls.map((call) => call.options.timeoutMs)).toEqual([20_000, 14_000, 8_000, 2_000]);
    expect(result).toEqual({
      ok: false,
      code: 'FEED_TIMEOUT',
      message: 'Feed discovery ran out of time before it found a feed',
    });
  });

  it('keeps candidates verified before the deadline', async () => {
    const web = manyAlternates(5, new FakeWeb());
    for (let i = 0; i < 5; i += 1)
      web.route(`${SITE}/feed-${i}`, { body: rss(`Feed ${i}`), tookMs: 8_000 });
    const result = success(await discoverFeed(`${SITE}/`, web.deps({ maxConcurrentProbes: 1 })));
    expect(result.candidates.map((candidate) => candidate.title)).toEqual([
      'Feed 0',
      'Feed 1',
      'Feed 2',
    ]);
  });

  it('honours custom limits and reports degenerate ones', async () => {
    const web = new FakeWeb().route(`${SITE}/`, { body: rss() });
    expect(await discoverFeed(`${SITE}/`, web.deps({ deadlineMs: 0 }))).toMatchObject({
      ok: false,
      code: 'FEED_TIMEOUT',
    });
    expect(await discoverFeed(`${SITE}/`, web.deps({ maxRequests: 0 }))).toMatchObject({
      ok: false,
      code: 'FEED_NOT_A_FEED',
    });
    expect(web.calls).toEqual([]);
    success(await discoverFeed(`${SITE}/`, web.deps({ deadlineMs: 5, maxRequests: 1 })));
    expect(web.calls.map((call) => call.options)).toEqual([
      { purpose: 'discovery', timeoutMs: 5, maxRedirects: 0 },
    ]);
  });

  it('verifies at most two candidates at a time', async () => {
    const web = manyAlternates(6, new FakeWeb());
    for (let i = 0; i < 6; i += 1)
      web.route(`${SITE}/feed-${i}`, { body: rss(`Feed ${i}`), delayMs: 5 });
    const result = success(await discoverFeed(`${SITE}/`, web.deps()));
    expect(result.candidates).toHaveLength(6);
    expect(web.maxInFlight).toBe(2);
  });
});

describe('discoverFeed: probing common paths', () => {
  it('probes the six paths on the final origin and takes the first feed in path order', async () => {
    const [feed, rssPath, rssXml, atomXml] = [deferred(), deferred(), deferred(), deferred()];
    const origin = 'https://www.blog.example';
    const web = new FakeWeb()
      .route('https://blog.example/', {
        body: htmlPage(),
        contentType: HTML,
        finalUrl: `${origin}/start`,
      })
      .route(`${origin}/feed`, { fail: 'FEED_HTTP_404', gate: feed.promise })
      .route(`${origin}/rss`, { body: htmlPage(), contentType: HTML, gate: rssPath.promise })
      .route(`${origin}/rss.xml`, { body: atom('Earlier path'), gate: rssXml.promise })
      .route(`${origin}/atom.xml`, { body: atom('Later path'), gate: atomXml.promise });
    const discovery = discoverFeed('https://blog.example/', web.deps());

    await until(() => web.calls.length === 3);
    expect(web.maxInFlight).toBe(2);
    feed.open();
    await until(() => web.calls.length === 4);
    rssPath.open();
    await until(() => web.calls.length === 5);
    atomXml.open(); // /atom.xml is a feed, but /rss.xml comes first in path order
    await until(() => web.parsed.length === 3);
    rssXml.open();

    const result = success(await discovery);
    expect(result.candidates).toEqual([
      {
        url: `${origin}/rss.xml`,
        canonicalUrl: `${origin}/rss.xml`,
        title: 'Earlier path',
        type: 'atom',
      },
    ]);
    expect(result.validated?.parsed.kind).toBe('atom');
    expect(web.urls()).toEqual([
      'https://blog.example/',
      `${origin}/feed`,
      `${origin}/rss`,
      `${origin}/rss.xml`,
      `${origin}/atom.xml`,
    ]);
    expect(web.maxInFlight).toBe(2);
  });

  it('aborts a probe that can no longer win and starts no later ones', async () => {
    const web = new FakeWeb()
      .route(`${SITE}/`, { body: htmlPage(), contentType: HTML })
      .route(`${SITE}/feed`, { body: rss('Winner'), delayMs: 5 })
      .route(`${SITE}/rss`, { body: rss('Too slow'), delayMs: 10_000 });
    const started = Date.now();
    const result = success(await discoverFeed(`${SITE}/`, web.deps()));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.candidates.map((candidate) => candidate.title)).toEqual(['Winner']);
    expect(web.urls()).toEqual([`${SITE}/`, `${SITE}/feed`, `${SITE}/rss`]);
    expect(web.calls[1]?.options.signal?.aborted).toBe(false);
    expect(web.calls[2]?.options.signal?.aborted).toBe(true);
  });

  it('prefers an earlier path that finishes later', async () => {
    const web = new FakeWeb()
      .route(`${SITE}/`, { body: htmlPage(), contentType: HTML })
      .route(`${SITE}/feed`, { body: rss('First path'), delayMs: 25 })
      .route(`${SITE}/rss`, { body: rss('Second path'), delayMs: 1 });
    const result = success(await discoverFeed(`${SITE}/`, web.deps()));
    expect(result.candidates.map((candidate) => candidate.title)).toEqual(['First path']);
    expect(web.urls()).toEqual([`${SITE}/`, `${SITE}/feed`, `${SITE}/rss`]);
  });

  it('skips the probe that is the page itself', async () => {
    const web = new FakeWeb()
      .route(`${SITE}/feed`, { body: htmlPage(), contentType: HTML })
      .route(`${SITE}/index.xml`, { body: rss('Hugo') });
    const result = success(await discoverFeed(`${SITE}/feed`, web.deps()));
    expect(result.candidates[0]?.title).toBe('Hugo');
    expect(web.urls()).not.toContain(`${SITE}/feed#probe`);
    expect(web.urls().filter((url) => url === `${SITE}/feed`)).toHaveLength(1);
  });

  it('reports FEED_NOT_A_FEED when neither links nor probes find a feed', async () => {
    const web = new FakeWeb().route(`${SITE}/`, { body: htmlPage(), contentType: HTML });
    web.route(`${SITE}/feed`, { fail: 'FEED_HTTP_500' });
    expect(await discoverFeed(`${SITE}/`, web.deps())).toEqual({
      ok: false,
      code: 'FEED_NOT_A_FEED',
      message: 'No feed was found at this address',
    });
    expect(web.urls()).toEqual([`${SITE}/`, ...FEED_PROBE_PATHS.map((path) => `${SITE}${path}`)]);
  });

  it('reports an inconclusive candidate failure instead of FEED_NOT_A_FEED', async () => {
    const retryAt = new Date('2026-09-26T13:00:00Z');
    const web = new FakeWeb()
      .route(`${SITE}/`, { body: htmlPage(alternate(RSS, '/feed/')), contentType: HTML })
      .route(`${SITE}/feed/`, { fail: 'FEED_HTTP_503', message: 'HTTP 503', retryAt });
    expect(await discoverFeed(`${SITE}/`, web.deps())).toEqual({
      ok: false,
      code: 'FEED_HTTP_503',
      message: 'HTTP 503',
      retryAt,
    });
  });
});

describe('discoverFeed: failures of injected dependencies', () => {
  it('returns INTERNAL when the page fetch rejects', async () => {
    const cause = new Error('origin limiter unavailable');
    const web = new FakeWeb();
    const result = await discoverFeed(`${SITE}/`, web.deps({ fetch: () => Promise.reject(cause) }));
    expect(result).toEqual({
      ok: false,
      code: 'INTERNAL',
      message: 'Feed discovery failed unexpectedly',
      cause,
    });
  });

  it('returns INTERNAL when a candidate fetch rejects, after in-flight fetches settle', async () => {
    const cause = new Error('database is down');
    const web = new FakeWeb()
      .route(`${SITE}/`, {
        body: htmlPage(alternate(RSS, '/a') + alternate(RSS, '/b') + alternate(RSS, '/c')),
        contentType: HTML,
      })
      .route(`${SITE}/b`, { body: rss(), delayMs: 1_000 });
    const result = await discoverFeed(
      `${SITE}/`,
      web.deps({
        fetch: (url, options) =>
          url === `${SITE}/a` ? Promise.reject(cause) : web.fetch(url, options),
      }),
    );
    expect(result).toMatchObject({ ok: false, code: 'INTERNAL', cause });
    expect(web.urls()).toEqual([`${SITE}/`, `${SITE}/b`]);
    expect(web.calls[1]?.options.signal?.aborted).toBe(true);
  });

  it('returns INTERNAL when parsing rejects', async () => {
    const cause = new Error('parser worker crashed');
    const web = new FakeWeb().route(`${SITE}/`, { body: rss() });
    expect(
      await discoverFeed(`${SITE}/`, web.deps({ parse: () => Promise.reject(cause) })),
    ).toMatchObject({ ok: false, code: 'INTERNAL', cause });
  });
});

describe('discoverFeed: cancellation', () => {
  it('sends nothing when already cancelled', async () => {
    const web = new FakeWeb().route(`${SITE}/`, { body: rss() });
    const result = await discoverFeed(`${SITE}/`, web.deps({ signal: AbortSignal.abort() }));
    expect(result).toEqual({
      ok: false,
      code: 'FEED_TIMEOUT',
      message: 'Feed discovery was cancelled',
    });
    expect(web.calls).toEqual([]);
  });

  it('stops probing when cancelled and passes the signal to every fetch', async () => {
    const controller = new AbortController();
    const web = new FakeWeb()
      .route(`${SITE}/`, { body: htmlPage(), contentType: HTML })
      .route(`${SITE}/feed`, () => {
        controller.abort();
        return { fail: 'FEED_HTTP_404' };
      });
    const result = await discoverFeed(
      `${SITE}/`,
      web.deps({ signal: controller.signal, maxConcurrentProbes: 1 }),
    );
    expect(result).toEqual({
      ok: false,
      code: 'FEED_TIMEOUT',
      message: 'Feed discovery was cancelled',
    });
    expect(web.urls()).toEqual([`${SITE}/`, `${SITE}/feed`]);
    expect(web.calls[0]?.options.signal).toBe(controller.signal);
    expect(web.calls[1]?.options.signal?.aborted).toBe(true);
  });
});
