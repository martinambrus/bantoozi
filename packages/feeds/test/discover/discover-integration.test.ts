import { fixturePath, startFixtureServer, type FixtureServer } from '@bantoozi/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { discoverFeed, FEED_PROBE_PATHS, type DiscoverDeps } from '../../src/discover/index.js';
import { decodeBody, safeFetch } from '../../src/http/index.js';
import { parseFeed } from '../../src/parse/index.js';

let server: FixtureServer;

/**
 * The API's wiring of discovery (spec 08 §4): the real `safeFetch` bound to a user agent and body
 * cap (FETCH_ALLOW_PRIVATE for the loopback fixture server), the real `decodeBody` and `parseFeed`.
 */
function wire(): DiscoverDeps {
  return {
    fetch: (url, options) =>
      safeFetch(url, {
        ...options,
        userAgent: 'BantooziBot/1.0 (+http://localhost/bot)',
        maxBytes: 5 * 1024 * 1024,
        allowPrivate: true,
      }),
    parse: parseFeed,
    decode: decodeBody,
    allowPrivate: true,
  };
}

const HTML = { 'content-type': 'text/html; charset=utf-8' };

function page(head: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Site</title>${head}</head><body><p>Hello</p></body></html>`;
}

const requestedPaths = (): string[] => server.requests.map((request) => request.path);

beforeAll(async () => {
  server = await startFixtureServer({ root: fixturePath('feeds') });
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  server.reset();
});

describe('spec 03 §10 discovery over the real safeFetch, decodeBody and parseFeed', () => {
  it('offers a feed URL as the single candidate and reuses its parse', async () => {
    const result = await discoverFeed(server.url('/rss2.xml'), wire());
    expect(result).toMatchObject({
      ok: true,
      candidates: [
        {
          url: server.url('/rss2.xml'),
          canonicalUrl: server.url('/rss2.xml'),
          title: 'Example Engineering Blog',
          type: 'rss',
        },
      ],
      validated: { parsed: { kind: 'rss', feed: { title: 'Example Engineering Blog' } } },
    });
    expect(result.ok && result.validated?.parsed.items.length).toBeGreaterThan(0);
    expect(requestedPaths()).toEqual(['/rss2.xml']);
  });

  it('decodes a windows-1250 feed (a Slovak site) by its XML declaration', async () => {
    // Without an HTTP charset; the fixture server's default `.xml` type claims UTF-8.
    server.route('/sk.xml', {
      file: 'windows-1250.xml',
      headers: { 'content-type': 'application/rss+xml' },
    });
    const result = await discoverFeed(server.url('/sk.xml'), wire());
    expect(result).toMatchObject({
      ok: true,
      candidates: [{ title: 'Východoslovenský denník – Správy', type: 'rss' }],
    });
  });

  it('follows the single <link rel="alternate"> of an HTML page and verifies it', async () => {
    server.route('/feed.xml', { file: 'jsonfeed-1.1.json' });
    const result = await discoverFeed(server.url('/not-a-feed.html'), wire());
    expect(result).toMatchObject({
      ok: true,
      candidates: [{ url: server.url('/feed.xml'), title: 'Example Microblog', type: 'json' }],
      validated: { parsed: { kind: 'json' } },
    });
    expect(requestedPaths()).toEqual(['/not-a-feed.html', '/feed.xml']);
  });

  it('returns every verified alternate for the user to choose', async () => {
    server.route('/', {
      headers: HTML,
      body: page(
        [
          '<link rel="alternate" type="application/json" href="/wp-json/wp/v2/pages/2">',
          '<link rel="alternate" type="application/rss+xml" title="Blog » Feed" href="/rss2.xml">',
          '<link rel="alternate" type="application/rss+xml" title="Gone" href="/missing.xml">',
          '<link rel="alternate" type="application/atom+xml" href="atom.xml">',
          '<link rel="alternate" type="application/feed+json" href="/jsonfeed-1.1.json">',
        ].join(''),
      ),
    });
    server.route('/wp-json/wp/v2/pages/2', {
      headers: { 'content-type': 'application/json' },
      body: '{"id": 2, "title": {"rendered": "About"}}',
    });
    const result = await discoverFeed(server.url('/'), wire());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.validated).toBeUndefined();
    expect(result.candidates.map(({ url, title, type }) => ({ url, title, type }))).toEqual([
      { url: server.url('/rss2.xml'), title: 'Example Engineering Blog', type: 'rss' },
      { url: server.url('/atom.xml'), title: 'Field Notes', type: 'atom' },
      { url: server.url('/jsonfeed-1.1.json'), title: 'Example Microblog', type: 'json' },
    ]);
    expect(requestedPaths()).toContain('/wp-json/wp/v2/pages/2');
  });

  it('probes common paths when the page declares no feed', async () => {
    server.route('/blog/', { headers: HTML, body: page('') });
    server.route('/rss.xml', { file: 'rdf.xml' });
    const result = await discoverFeed(server.url('/blog/'), wire());
    expect(result).toMatchObject({
      ok: true,
      candidates: [{ url: server.url('/rss.xml'), type: 'rdf' }],
      validated: { parsed: { kind: 'rdf' } },
    });
    expect(requestedPaths().slice(0, 4)).toEqual(['/blog/', '/feed', '/rss', '/rss.xml']);
  });

  it('reports FEED_NOT_A_FEED when nothing parses as a feed', async () => {
    server.route('/about', { headers: HTML, body: page('') });
    for (const path of FEED_PROBE_PATHS) server.route(path, { status: 404, body: 'not found' });
    const result = await discoverFeed(server.url('/about'), wire());
    expect(result).toMatchObject({ ok: false, code: 'FEED_NOT_A_FEED' });
    expect(requestedPaths()).toEqual(['/about', ...FEED_PROBE_PATHS]);
  });

  it('adopts a permanently redirected feed URL but keeps a temporarily redirected one', async () => {
    server.redirect('/old-feed', '/rss2.xml', 301);
    server.redirect('/today', '/atom.xml', 302);
    expect(await discoverFeed(server.url('/old-feed'), wire())).toMatchObject({
      ok: true,
      candidates: [{ url: server.url('/rss2.xml'), canonicalUrl: server.url('/rss2.xml') }],
    });
    expect(await discoverFeed(server.url('/today'), wire())).toMatchObject({
      ok: true,
      candidates: [{ url: server.url('/today'), title: 'Field Notes' }],
    });
  });

  it("returns the page's HTTP failure", async () => {
    server.route('/gone', { status: 410, body: 'gone' });
    expect(await discoverFeed(server.url('/gone'), wire())).toMatchObject({
      ok: false,
      code: 'FEED_HTTP_410',
    });
  });

  it('does not fall back to http when the https attempt fails TLS', async () => {
    // The fixture server speaks plain HTTP, so the https:// attempt of a scheme-less input fails
    // its TLS handshake; that is never a reason to retry without TLS (spec 03 §10 step 6).
    const hostAndPath = server.url('/rss2.xml').replace(/^http:\/\//, '');
    const result = await discoverFeed(hostAndPath, wire());
    expect(result).toMatchObject({ ok: false, code: 'FEED_TLS_ERROR' });
    expect(requestedPaths()).toEqual([]);
  });
});
