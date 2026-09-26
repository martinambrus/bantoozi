import { randomBytes } from 'node:crypto';
import { createServer, type AddressInfo } from 'node:net';
import { brotliCompressSync, deflateRawSync, deflateSync, gzipSync } from 'node:zlib';

import {
  FIXTURES_DIR,
  readFixture,
  startFixtureServer,
  type FixtureServer,
} from '@bantoozi/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { decodeBody } from '../../src/http/decode-body.js';
import {
  ACCEPT_HEADERS,
  safeFetch,
  type SafeFetchOptions,
  type SafeFetchResult,
} from '../../src/http/safe-fetch.js';
import {
  expectFailure,
  expectOk,
  mapResolver,
  options,
  PUBLIC_HOSTS,
  startSeamHarness,
  text,
  USER_AGENT,
} from './helpers.js';
import { startRawServer } from './raw-server.js';

let fixture: FixtureServer;

/** Fetches from the local fixture server (FETCH_ALLOW_PRIVATE: loopback, random port). */
const local = (path: string, overrides: Partial<SafeFetchOptions> = {}): Promise<SafeFetchResult> =>
  safeFetch(fixture.url(path), options({ allowPrivate: true, ...overrides }));

const paths = (): string[] => fixture.requests.map((request) => request.path);

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

beforeAll(async () => {
  fixture = await startFixtureServer({ root: FIXTURES_DIR });
});

afterAll(async () => {
  await fixture.close();
});

beforeEach(() => {
  fixture.reset();
});

describe('spec 03 §4 safeFetch', () => {
  describe('§4.1 schemes, userinfo and length → FEED_INVALID_URL (never a throw)', () => {
    it.each([
      ['an empty string', ''],
      ['not a URL', 'not a url'],
      ['a relative URL', '/feed.xml'],
      ['ftp:', 'ftp://public.example/feed'],
      ['file:', 'file:///etc/passwd'],
      ['javascript:', 'javascript:alert(1)'],
      ['data:', 'data:text/plain,hello'],
      ['gopher:', 'gopher://public.example:70/'],
      ['user and password', 'http://user:secret@public.example/feed'],
      ['a user only', 'https://secret@public.example/feed'],
      ['an unterminated IPv6 literal', 'http://[::1/'],
      ['a space in the host', 'http://exa mple.com/'],
      ['a port out of range', 'http://public.example:99999/'],
      ['more than 8,192 bytes', `https://public.example/${'a'.repeat(9000)}`],
    ])('rejects %s', async (_label, url) => {
      const { resolver, calls } = mapResolver(PUBLIC_HOSTS);
      const result = expectFailure(await safeFetch(url, options({ resolver })));
      expect(result.code).toBe('FEED_INVALID_URL');
      expect(result.message).not.toContain('secret');
      expect(calls).toEqual([]);
    });

    it('rejects non-string input without throwing', async () => {
      for (const input of [undefined, null, 42, {}]) {
        const result = await safeFetch(input as unknown as string, options());
        expect(result).toMatchObject({ ok: false, code: 'FEED_INVALID_URL' });
      }
    });

    it('measures the normalized URL too (percent-encoding can triple its length)', async () => {
      const url = `http://public.example/${'é'.repeat(3000)}`;
      expect(Buffer.byteLength(url)).toBeLessThan(8192);
      const result = await safeFetch(
        url,
        options({ resolver: mapResolver(PUBLIC_HOSTS).resolver }),
      );
      expect(result).toMatchObject({ ok: false, code: 'FEED_INVALID_URL' });
    });

    it('accepts a URL of exactly 8,192 bytes', async () => {
      const harness = await startSeamHarness();
      try {
        const prefix = 'http://public.example/';
        const url = `${prefix}${'a'.repeat(8192 - prefix.length)}`;
        harness.fixture.route(new URL(url).pathname, { body: 'ok' });
        const result = expectOk(await harness.fetch(url));
        expect(Buffer.byteLength(result.finalUrl)).toBe(8192);
      } finally {
        await harness.close();
      }
    });
  });

  describe('§4.3 redirects are followed manually and re-validated on every hop', () => {
    it('records each hop {status, from, to} and the final URL; resolves relative Locations', async () => {
      fixture.redirect('/a', '/b', 302);
      fixture.redirect('/b', fixture.url('/c'), 307);
      fixture.redirect('/c', 'feed', 303);
      fixture.route('/feed', { body: '<rss/>' });
      const result = expectOk(await local('/a'));
      expect(result.redirects).toEqual([
        { status: 302, from: fixture.url('/a'), to: fixture.url('/b') },
        { status: 307, from: fixture.url('/b'), to: fixture.url('/c') },
        { status: 303, from: fixture.url('/c'), to: fixture.url('/feed') },
      ]);
      expect(result.finalUrl).toBe(fixture.url('/feed'));
      expect(result.permanentRedirect).toBe(false);
      expect(text(result.bodyBytes)).toBe('<rss/>');
    });

    it('permanentRedirect is true when every hop is 301/308 (301 → 308)', async () => {
      fixture.redirect('/a', '/b', 301);
      fixture.redirect('/b', '/feed', 308);
      fixture.route('/feed', { body: 'x' });
      const result = expectOk(await local('/a'));
      expect(result.permanentRedirect).toBe(true);
      expect(result.redirects.map((hop) => hop.status)).toEqual([301, 308]);
    });

    it('a permanent hop followed by a temporary hop is not permanent (301 → 302)', async () => {
      fixture.redirect('/a', '/b', 301);
      fixture.redirect('/b', '/feed', 302);
      fixture.route('/feed', { body: 'x' });
      const result = expectOk(await local('/a'));
      expect(result.permanentRedirect).toBe(false);
      expect(result.finalUrl).toBe(fixture.url('/feed'));
    });

    it('a fetch without redirects is not a permanent redirect', async () => {
      fixture.route('/feed', { body: 'x' });
      const result = expectOk(await local('/feed'));
      expect(result).toMatchObject({ permanentRedirect: false, redirects: [] });
    });

    it('follows 5 hops', async () => {
      for (let i = 1; i <= 5; i += 1) fixture.redirect(`/h${i}`, `/h${i + 1}`, 301);
      fixture.route('/h6', { body: 'end' });
      const result = expectOk(await local('/h1'));
      expect(result.redirects).toHaveLength(5);
      expect(result.permanentRedirect).toBe(true);
    });

    it('more than 5 hops → FEED_TOO_MANY_REDIRECTS; the 6th target is never requested', async () => {
      for (let i = 1; i <= 6; i += 1) fixture.redirect(`/h${i}`, `/h${i + 1}`, 301);
      fixture.route('/h7', { body: 'end' });
      const result = expectFailure(await local('/h1'));
      expect(result.code).toBe('FEED_TOO_MANY_REDIRECTS');
      expect(result.status).toBe(301);
      expect(result.redirects).toHaveLength(5);
      expect(result.finalUrl).toBe(fixture.url('/h6'));
      expect(paths()).toEqual(['/h1', '/h2', '/h3', '/h4', '/h5', '/h6']);
    });

    it('honours maxRedirects', async () => {
      fixture.redirect('/a', '/feed', 302);
      fixture.route('/feed', { body: 'x' });
      expect(await local('/a', { maxRedirects: 0 })).toMatchObject({
        code: 'FEED_TOO_MANY_REDIRECTS',
      });
      expectOk(await local('/a', { maxRedirects: 1 }));
    });

    it('rejects a redirect loop', async () => {
      fixture.redirect('/a', '/b', 302);
      fixture.redirect('/b', '/a', 302);
      const result = expectFailure(await local('/a'));
      expect(result.code).toBe('FEED_TOO_MANY_REDIRECTS');
      expect(result.message).toContain('loop');
      expect(paths()).toEqual(['/a', '/b']);
    });

    it('rejects a redirect to the same URL (ignoring the fragment)', async () => {
      fixture.redirect('/a', '/a#top', 301);
      expect(await local('/a')).toMatchObject({ code: 'FEED_TOO_MANY_REDIRECTS' });
    });

    it('a redirect without Location → FEED_HTTP_<status>', async () => {
      fixture.route('/a', { status: 301 });
      const result = expectFailure(await local('/a'));
      expect(result).toMatchObject({ code: 'FEED_HTTP_301', status: 301 });
      expect(result.message).toContain('Location');
    });

    it.each([
      ['ftp://public.example/feed', 'ftp://public.example/feed'],
      ['javascript:alert(1)', 'javascript:alert(1)'],
      ['http://user:pw@public.example/feed', 'http://user:pw@public.example/feed'],
    ])('rejects the unsupported Location %s as FEED_INVALID_URL', async (location, normalized) => {
      fixture.redirect('/a', location, 302);
      const result = expectFailure(await local('/a'));
      expect(result.code).toBe('FEED_INVALID_URL');
      expect(result.finalUrl).toBe(normalized);
      expect(result.redirects).toHaveLength(1);
    });

    it('rejects an unparseable Location as FEED_INVALID_URL', async () => {
      fixture.redirect('/a', 'http://[::1', 302);
      const result = expectFailure(await local('/a'));
      expect(result).toMatchObject({ code: 'FEED_INVALID_URL', status: 302, redirects: [] });
      expect(result.finalUrl).toBe(fixture.url('/a'));
    });

    it('rejects conflicting Location headers', async () => {
      const raw = await startRawServer((socket) => {
        socket.end(
          'HTTP/1.1 302 Found\r\nlocation: /a\r\nlocation: /b\r\ncontent-length: 0\r\n\r\n',
        );
      });
      try {
        const result = await safeFetch(raw.url('/'), options({ allowPrivate: true }));
        expect(result).toMatchObject({ ok: false, code: 'FEED_INVALID_URL', status: 302 });
      } finally {
        await raw.close();
      }
    });

    it('strips conditional validators once the request URL changes', async () => {
      fixture.redirect('/old', '/new', 301);
      fixture.route('/new', { body: 'x' });
      expectOk(
        await local('/old', {
          conditional: { etag: '"v1"', lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT' },
        }),
      );
      const [first, second] = fixture.requests;
      expect(first?.headers['if-none-match']).toBe('"v1"');
      expect(first?.headers['if-modified-since']).toBe('Wed, 21 Oct 2015 07:28:00 GMT');
      expect(second?.headers['if-none-match']).toBeUndefined();
      expect(second?.headers['if-modified-since']).toBeUndefined();
    });

    it('never forwards cookies or credentials, and drops Set-Cookie from the result', async () => {
      fixture.route('/login', {
        status: 302,
        headers: { location: '/feed', 'set-cookie': 'session=abc; Path=/' },
      });
      fixture.route('/feed', { headers: { 'set-cookie': 'session=def' }, body: 'x' });
      const result = expectOk(await local('/login'));
      expect(result.headers['set-cookie']).toBeUndefined();
      for (const request of fixture.requests) {
        expect(request.headers.cookie).toBeUndefined();
        expect(request.headers.authorization).toBeUndefined();
      }
    });
  });

  describe('§4.4 limits', () => {
    it('caps decompressed bytes: a small gzip body inflating past maxBytes → FEED_TOO_LARGE', async () => {
      const bomb = gzipSync(Buffer.alloc(8 * 1024 * 1024, 0x61));
      expect(bomb.length).toBeLessThan(64 * 1024);
      fixture.route('/bomb', { headers: { 'content-encoding': 'gzip' }, body: bomb });
      const result = expectFailure(await local('/bomb', { maxBytes: 1024 * 1024 }));
      expect(result.code).toBe('FEED_TOO_LARGE');
      expect(result.message).toContain('decompressed');
    });

    it.each([
      ['br', brotliCompressSync],
      ['deflate', deflateSync],
    ] as const)('caps decompressed %s bytes', async (coding, compress) => {
      fixture.route('/bomb', {
        headers: { 'content-encoding': coding },
        body: compress(Buffer.alloc(2 * 1024 * 1024, 0x20)),
      });
      expect(await local('/bomb', { maxBytes: 256 * 1024 })).toMatchObject({
        code: 'FEED_TOO_LARGE',
      });
    });

    it('caps compressed bytes: a streamed body over maxBytes → FEED_TOO_LARGE', async () => {
      fixture.route('/big', { body: randomBytes(300 * 1024) });
      const result = expectFailure(await local('/big', { maxBytes: 100 * 1024 }));
      expect(result.code).toBe('FEED_TOO_LARGE');
    });

    it('a compressed body over the cap fails before it is decompressed', async () => {
      const incompressible = gzipSync(randomBytes(300 * 1024));
      fixture.route('/big.gz', { headers: { 'content-encoding': 'gzip' }, body: incompressible });
      const result = expectFailure(await local('/big.gz', { maxBytes: 100 * 1024 }));
      expect(result.code).toBe('FEED_TOO_LARGE');
      expect(result.message).not.toContain('decompressed');
    });

    it('a Content-Length above the cap fails before the body is read', async () => {
      const body = randomBytes(300 * 1024);
      fixture.route('/big', { headers: { 'content-length': String(body.length) }, body });
      const result = expectFailure(await local('/big', { maxBytes: 100 * 1024 }));
      expect(result.code).toBe('FEED_TOO_LARGE');
      expect(result.message).toContain('Content-Length');
    });

    it('a body of exactly maxBytes passes, compressed or not', async () => {
      const body = Buffer.alloc(4096, 0x61);
      fixture.route('/plain', { body });
      fixture.route('/gz', { headers: { 'content-encoding': 'gzip' }, body: gzipSync(body) });
      expect(expectOk(await local('/plain', { maxBytes: 4096 })).bodyBytes).toHaveLength(4096);
      expect(expectOk(await local('/gz', { maxBytes: 4096 })).bodyBytes).toHaveLength(4096);
    });

    it.each([
      ['gzip', gzipSync],
      ['x-gzip', gzipSync],
      ['deflate', deflateSync],
      ['deflate', deflateRawSync],
      ['br', brotliCompressSync],
      ['identity', (input: Buffer) => input],
    ] as const)('decodes Content-Encoding: %s', async (coding, compress) => {
      const payload = Buffer.from('<rss><channel><title>Žltý kôň</title></channel></rss>');
      fixture.route('/feed', { headers: { 'content-encoding': coding }, body: compress(payload) });
      const result = expectOk(await local('/feed'));
      expect(Buffer.from(result.bodyBytes).equals(payload)).toBe(true);
    });

    it('decodes stacked codings in reverse order, each exactly once', async () => {
      const payload = Buffer.from('stacked');
      fixture.route('/stacked', {
        headers: { 'content-encoding': 'gzip, br' },
        body: brotliCompressSync(gzipSync(payload)),
      });
      expect(text(expectOk(await local('/stacked')).bodyBytes)).toBe('stacked');
      // Double-compressed content labelled once is decoded once: the inner gzip stays.
      const inner = gzipSync(payload);
      fixture.route('/double', { headers: { 'content-encoding': 'gzip' }, body: gzipSync(inner) });
      expect(Buffer.from(expectOk(await local('/double')).bodyBytes).equals(inner)).toBe(true);
    });

    it.each([
      ['gzip', Buffer.from('this is not gzip at all')],
      ['gzip', gzipSync(Buffer.from('truncated body')).subarray(0, 12)],
      ['br', Buffer.from('garbage!!')],
      ['deflate', Buffer.from([0x78, 0x9c, 0xff, 0xff, 0xff])],
    ])('rejects a corrupt %s body as FEED_DECODE_ERROR', async (coding, body) => {
      fixture.route('/corrupt', { headers: { 'content-encoding': coding }, body });
      expect(await local('/corrupt')).toMatchObject({ ok: false, code: 'FEED_DECODE_ERROR' });
    });

    it.each(['zstd', 'compress', 'gzip, gzip, gzip, gzip'])(
      'rejects the unsupported Content-Encoding %s as FEED_DECODE_ERROR',
      async (coding) => {
        fixture.route('/odd', { headers: { 'content-encoding': coding }, body: 'x' });
        expect(await local('/odd')).toMatchObject({ ok: false, code: 'FEED_DECODE_ERROR' });
      },
    );

    it('limits response headers to 32 KiB → FEED_TOO_LARGE', async () => {
      fixture.route('/headers', { headers: { 'x-padding': 'a'.repeat(40 * 1024) }, body: 'x' });
      expect(await local('/headers')).toMatchObject({ ok: false, code: 'FEED_TOO_LARGE' });
      fixture.route('/headers', { headers: { 'x-padding': 'a'.repeat(16 * 1024) }, body: 'x' });
      expectOk(await local('/headers'));
    });

    it('one deadline: a slow server → FEED_TIMEOUT after timeoutMs', async () => {
      fixture.route('/slow', { delayMs: 3_000, body: 'late' });
      const started = Date.now();
      const result = expectFailure(await local('/slow', { timeoutMs: 300 }));
      expect(result.code).toBe('FEED_TIMEOUT');
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it('the headers timeout (10 s by default) is configurable', async () => {
      fixture.route('/slow', { delayMs: 2_000, body: 'late' });
      const result = expectFailure(await local('/slow', { headersTimeoutMs: 200 }));
      expect(result.code).toBe('FEED_TIMEOUT');
      expect(result.message).toContain('UND_ERR_HEADERS_TIMEOUT');
    });

    it('the deadline covers a stalled body', async () => {
      const raw = await startRawServer((socket) => {
        socket.write(
          'HTTP/1.1 200 OK\r\ncontent-type: text/xml\r\ncontent-length: 1000\r\n\r\n<rss>',
        );
      });
      try {
        const result = await safeFetch(
          raw.url('/'),
          options({ allowPrivate: true, timeoutMs: 400 }),
        );
        expect(result).toMatchObject({ ok: false, code: 'FEED_TIMEOUT' });
      } finally {
        await raw.close();
      }
    });

    it('the deadline covers the whole redirect chain, not each hop', async () => {
      // Every hop alone is well within timeoutMs; only their sum exceeds it.
      fixture.route('/r1', { delayMs: 250, status: 302, headers: { location: '/r2' } });
      fixture.route('/r2', { delayMs: 250, status: 302, headers: { location: '/feed' } });
      fixture.route('/feed', { delayMs: 250, body: 'x' });
      const result = expectFailure(await local('/r1', { timeoutMs: 600 }));
      expect(result.code).toBe('FEED_TIMEOUT');
      expect(result.redirects?.length).toBeGreaterThanOrEqual(1);
    });

    it('a caller abort ends the fetch with FEED_TIMEOUT', async () => {
      fixture.route('/slow', { delayMs: 2_000, body: 'late' });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 100);
      const result = expectFailure(await local('/slow', { signal: controller.signal }));
      expect(result.code).toBe('FEED_TIMEOUT');
      expect(result.message).toContain('aborted by the caller');
    });

    it('an already aborted signal sends nothing', async () => {
      fixture.route('/feed', { body: 'x' });
      const result = await local('/feed', { signal: AbortSignal.abort() });
      expect(result).toMatchObject({ ok: false, code: 'FEED_TIMEOUT' });
      expect(fixture.requests).toEqual([]);
    });
  });

  describe('§4.5 request headers', () => {
    it.each(['feed', 'page', 'robots', 'discovery'] as const)(
      'purpose %s: its Accept, the User-Agent and the accepted encodings',
      async (purpose) => {
        fixture.route('/x', { body: 'x' });
        expectOk(await local('/x', { purpose }));
        const [request] = fixture.requests;
        expect(request?.headers['user-agent']).toBe(USER_AGENT);
        expect(request?.headers.accept).toBe(ACCEPT_HEADERS[purpose]);
        expect(request?.headers['accept-encoding']).toBe('gzip, deflate, br');
        expect(request?.headers['if-none-match']).toBeUndefined();
        expect(request?.headers.cookie).toBeUndefined();
      },
    );

    it('Accept values match the purposes', () => {
      expect(ACCEPT_HEADERS.page).toBe('text/html,application/xhtml+xml');
      expect(ACCEPT_HEADERS.robots).toBe('text/plain');
      for (const type of ['application/rss+xml', 'application/atom+xml', 'application/feed+json']) {
        expect(ACCEPT_HEADERS.feed).toContain(type);
        expect(ACCEPT_HEADERS.discovery).toContain(type);
      }
      expect(ACCEPT_HEADERS.feed).toMatch(/\*\/\*;q=0\.\d$/);
      expect(ACCEPT_HEADERS.discovery).toContain('text/html');
    });

    it('an explicit accept overrides the purpose default; a per-feed UA is sent as is', async () => {
      fixture.route('/x', { body: 'x' });
      expectOk(await local('/x', { accept: 'application/json', userAgent: 'Custom/2.0' }));
      expect(fixture.requests[0]?.headers).toMatchObject({
        accept: 'application/json',
        'user-agent': 'Custom/2.0',
      });
    });

    it('sends If-None-Match / If-Modified-Since and drops unsafe validator values', async () => {
      fixture.route('/x', { body: 'x' });
      expectOk(
        await local('/x', {
          conditional: { etag: 'W/"abc"', lastModified: 'bad\r\nx-injected: 1' },
        }),
      );
      expect(fixture.requests[0]?.headers['if-none-match']).toBe('W/"abc"');
      expect(fixture.requests[0]?.headers['if-modified-since']).toBeUndefined();
      expect(fixture.requests[0]?.headers['x-injected']).toBeUndefined();
      fixture.reset();
      fixture.route('/x', { body: 'x' });
      expectOk(await local('/x', { conditional: { etag: null, lastModified: null } }));
      expect(fixture.requests[0]?.headers['if-none-match']).toBeUndefined();
    });
  });

  describe('§4.7 result type', () => {
    it('2xx → ok with the body and lower-case headers (repeated headers joined)', async () => {
      const raw = await startRawServer((socket) => {
        socket.end(
          'HTTP/1.1 200 OK\r\nContent-Type: application/rss+xml\r\nX-Multi: a\r\nX-Multi: b\r\n' +
            'Content-Length: 6\r\n\r\n<rss/>',
        );
      });
      try {
        const result = expectOk(await safeFetch(raw.url('/feed'), options({ allowPrivate: true })));
        expect(result.status).toBe(200);
        expect(result.headers['content-type']).toBe('application/rss+xml');
        expect(result.headers['x-multi']).toBe('a, b');
        expect(result.bodyBytes).toBeInstanceOf(Uint8Array);
        expect(text(result.bodyBytes)).toBe('<rss/>');
      } finally {
        await raw.close();
      }
    });

    it('204 → ok with an empty body', async () => {
      fixture.route('/empty', { status: 204, headers: { 'content-encoding': 'gzip' } });
      const result = expectOk(await local('/empty'));
      expect(result.status).toBe(204);
      expect(result.bodyBytes).toHaveLength(0);
    });

    it('304 → a bodyless success', async () => {
      fixture.route('/feed', (request) =>
        request.headers['if-none-match'] === '"v1"'
          ? { status: 304, headers: { etag: '"v1"' } }
          : { body: 'full' },
      );
      const result = expectOk(await local('/feed', { conditional: { etag: '"v1"' } }));
      expect(result).toMatchObject({ status: 304, headers: { etag: '"v1"' } });
      expect(result.bodyBytes).toHaveLength(0);
    });

    it.each([400, 401, 403, 404, 410, 500, 502])(
      'HTTP %i → FEED_HTTP_<status> with the response headers, no body',
      async (status) => {
        fixture.route('/x', { status, headers: { 'x-trace': 'abc' }, body: 'secret error page' });
        const result = expectFailure(await local('/x'));
        expect(result).toMatchObject({
          code: `FEED_HTTP_${status}`,
          status,
          finalUrl: fixture.url('/x'),
          headers: { 'x-trace': 'abc' },
        });
        expect(JSON.stringify(result)).not.toContain('secret error page');
      },
    );

    it('keeps Retry-After on HTTP failures', async () => {
      fixture.route('/busy', { status: 503, headers: { 'retry-after': '120' } });
      const result = expectFailure(await local('/busy'));
      expect(result.headers?.['retry-after']).toBe('120');
      expect(result.retryAt).toBeInstanceOf(Date);
    });

    it('3xx statuses that are not redirects are HTTP failures', async () => {
      fixture.route('/choices', { status: 300, headers: { location: '/a' } });
      expect(await local('/choices')).toMatchObject({ code: 'FEED_HTTP_300', status: 300 });
    });

    it('an invalid status code → FEED_CONNECTION_ERROR', async () => {
      const raw = await startRawServer((socket) => {
        socket.end('HTTP/1.1 999 Nope\r\ncontent-length: 0\r\n\r\n');
      });
      try {
        const result = await safeFetch(raw.url(), options({ allowPrivate: true }));
        expect(result).toMatchObject({ ok: false, code: 'FEED_CONNECTION_ERROR' });
      } finally {
        await raw.close();
      }
    });

    it('never throws or rejects for network, HTTP or URL errors', async () => {
      const reset = await startRawServer((socket) => socket.resetAndDestroy());
      fixture.route('/missing', { status: 404 });
      try {
        const cases: [string, Partial<SafeFetchOptions>][] = [
          ['', {}],
          ['::::', {}],
          ['ftp://public.example/', {}],
          ['mailto:someone@example.com', {}],
          ['http://user:pw@public.example/', {}],
          [`http://public.example/${'x'.repeat(10_000)}`, {}],
          ['http://127.0.0.1/', {}],
          ['http://[::1]:8080/', {}],
          [fixture.url('/missing'), { allowPrivate: true }],
          [reset.url(), { allowPrivate: true }],
          [`http://127.0.0.1:${await unusedPort()}/`, { allowPrivate: true }],
          [
            'http://evil.example/',
            { resolver: mapResolver({ 'evil.example': '10.0.0.1' }).resolver },
          ],
          ['http://nx.example/', { resolver: mapResolver({}).resolver }],
          ['http://boom.example/', { resolver: () => Promise.reject(new Error('resolver bug')) }],
        ];
        const settled = await Promise.allSettled(
          cases.map(([url, overrides]) => safeFetch(url, options(overrides))),
        );
        for (const outcome of settled) {
          expect(outcome.status).toBe('fulfilled');
          if (outcome.status === 'fulfilled') expect(outcome.value.ok).toBe(false);
        }
      } finally {
        await reset.close();
      }
    });

    it('rejects only for invalid options (programming errors)', async () => {
      const url = 'http://public.example/';
      const invalid: Partial<SafeFetchOptions>[] = [
        { timeoutMs: 0 },
        { timeoutMs: Number.NaN },
        { timeoutMs: 2 ** 31 },
        { maxBytes: -5 },
        { maxBytes: 0 },
        { maxBytes: 1.5 },
        { userAgent: '' },
        { userAgent: 'Bot\r\nx-injected: 1' },
        { accept: 'text/html\n' },
        { purpose: 'other' as SafeFetchOptions['purpose'] },
        { headersTimeoutMs: -1 },
        { maxRedirects: -1 },
      ];
      const { resolver, calls } = mapResolver(PUBLIC_HOSTS);
      for (const overrides of invalid) {
        await expect(safeFetch(url, options({ resolver, ...overrides }))).rejects.toThrow(
          /safeFetch:/,
        );
      }
      expect(calls).toEqual([]);
    });
  });

  describe('§4.8 error codes', () => {
    it('refused connection → FEED_CONNECTION_ERROR', async () => {
      const result = expectFailure(
        await safeFetch(`http://127.0.0.1:${await unusedPort()}/`, options({ allowPrivate: true })),
      );
      expect(result.code).toBe('FEED_CONNECTION_ERROR');
      expect(result.message).toContain('ECONNREFUSED');
    });

    it('a server that resets connections → FEED_CONNECTION_ERROR', async () => {
      const raw = await startRawServer((socket) => socket.resetAndDestroy());
      try {
        const result = await safeFetch(raw.url(), options({ allowPrivate: true }));
        expect(result).toMatchObject({ ok: false, code: 'FEED_CONNECTION_ERROR' });
      } finally {
        await raw.close();
      }
    });

    it('a server that closes without answering → FEED_CONNECTION_ERROR', async () => {
      const raw = await startRawServer((socket) => socket.end());
      try {
        const result = await safeFetch(raw.url(), options({ allowPrivate: true }));
        expect(result).toMatchObject({ ok: false, code: 'FEED_CONNECTION_ERROR' });
      } finally {
        await raw.close();
      }
    });

    it('a non-HTTP answer → FEED_CONNECTION_ERROR', async () => {
      const raw = await startRawServer((socket) => socket.end('SSH-2.0-OpenSSH_9.6\r\n\r\n'));
      try {
        const result = await safeFetch(raw.url(), options({ allowPrivate: true }));
        expect(result).toMatchObject({ ok: false, code: 'FEED_CONNECTION_ERROR' });
      } finally {
        await raw.close();
      }
    });

    it('a body cut short (Content-Length mismatch) → FEED_CONNECTION_ERROR', async () => {
      const raw = await startRawServer((socket) => {
        socket.end('HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\nshort');
      });
      try {
        const result = await safeFetch(raw.url(), options({ allowPrivate: true }));
        expect(result).toMatchObject({ ok: false, code: 'FEED_CONNECTION_ERROR' });
      } finally {
        await raw.close();
      }
    });

    it('a TLS failure → FEED_TLS_ERROR (verification is always on)', async () => {
      const harness = await startSeamHarness();
      try {
        // The dial seam sends https://public.example to the plain-HTTP fixture server.
        const result = expectFailure(await harness.fetch('https://public.example/feed'));
        expect(result.code).toBe('FEED_TLS_ERROR');
        expect(harness.dialed).toMatchObject([{ port: 443, protocol: 'https:' }]);
      } finally {
        await harness.close();
      }
    });
  });

  describe('§4.9 FETCH_ALLOW_PRIVATE escape hatch', () => {
    it('with allowPrivate=true a fixture server on a random port is reachable', async () => {
      fixture.route('/feed.xml', {
        headers: { 'content-type': 'application/rss+xml' },
        body: '<rss/>',
      });
      expect(fixture.port).not.toBe(80);
      const result = expectOk(await local('/feed.xml'));
      expect(result.finalUrl).toBe(fixture.url('/feed.xml'));
      expect(text(result.bodyBytes)).toBe('<rss/>');
    });

    it('also through a hostname resolved to loopback (safeLookup in the real connect path)', async () => {
      fixture.route('/feed.xml', { body: '<rss/>' });
      const { resolver, calls } = mapResolver({ 'fixture.test': '127.0.0.1' });
      const result = expectOk(
        await safeFetch(
          `http://fixture.test:${fixture.port}/feed.xml`,
          options({ allowPrivate: true, resolver }),
        ),
      );
      expect(result.status).toBe(200);
      expect(calls).toEqual(['fixture.test']);
      expect(fixture.requests[0]?.headers.host).toBe(`fixture.test:${fixture.port}`);
    });

    it('without it the same fixture URL is blocked', async () => {
      fixture.route('/feed.xml', { body: '<rss/>' });
      const result = await safeFetch(fixture.url('/feed.xml'), options());
      expect(result).toMatchObject({ ok: false, code: 'FEED_BLOCKED_ADDRESS' });
      expect(fixture.requests).toEqual([]);
    });

    it('never uses an environment proxy', async () => {
      const names = [
        'HTTP_PROXY',
        'http_proxy',
        'HTTPS_PROXY',
        'https_proxy',
        'ALL_PROXY',
      ] as const;
      const saved = names.map((name) => [name, process.env[name]] as const);
      for (const name of names) process.env[name] = 'http://127.0.0.1:9';
      try {
        fixture.route('/feed.xml', { body: '<rss/>' });
        expectOk(await local('/feed.xml'));
      } finally {
        for (const [name, value] of saved) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    });
  });

  describe('charset decoding of fetched fixtures (spec 03 §4 "Charset decoding")', () => {
    it('a windows-1250 feed and a <meta charset> page decode correctly after safeFetch', async () => {
      fixture.route('/feed', {
        file: 'charset/windows-1250.xml',
        headers: { 'content-type': 'application/rss+xml' },
      });
      fixture.route('/page', {
        file: 'charset/meta-charset.html',
        headers: { 'content-type': 'text/html' },
      });
      const feed = expectOk(await local('/feed'));
      const page = expectOk(await local('/page', { purpose: 'page' }));
      expect(Buffer.from(feed.bodyBytes).equals(readFixture('charset', 'windows-1250.xml'))).toBe(
        true,
      );
      const feedText = decodeBody(feed.bodyBytes, feed.headers['content-type']);
      const pageText = decodeBody(page.bodyBytes, page.headers['content-type']);
      expect(feedText).toMatchObject({ ok: true, encoding: 'windows-1250' });
      expect(pageText).toMatchObject({ ok: true, encoding: 'windows-1250' });
      if (feedText.ok) expect(feedText.text).toContain('<title>Žltý kôň úpäl ďábelské ódy</title>');
      if (pageText.ok) expect(pageText.text).toContain('<h1>Žltý kôň úpäl ďábelské ódy</h1>');
    });
  });
});
