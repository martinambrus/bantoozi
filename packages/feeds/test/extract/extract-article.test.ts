import { readFixture } from '@bantoozi/testing';
import { describe, expect, it, vi } from 'vitest';

const decoding = vi.hoisted(() => ({ fails: false, throws: false }));

vi.mock('../../src/http/index.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const decodeBody = actual['decodeBody'] as (bytes: Uint8Array, contentType?: string) => unknown;
  return {
    ...actual,
    decodeBody: (bytes: Uint8Array, contentType?: string) => {
      if (decoding.throws) throw new Error('decoder crashed');
      return decoding.fails
        ? { ok: false, code: 'FEED_DECODE_ERROR', message: 'unsupported character encoding' }
        : decodeBody(bytes, contentType);
    },
  };
});

import {
  EXTRACTOR_VERSION,
  extractArticle,
  type ExtractDeps,
  type PageFetchOptions,
  type RobotsChecker,
  type RobotsDecision,
} from '../../src/extract/index.js';
import type { SafeFetchResult } from '../../src/http/index.js';

const ARTICLE_URL = 'https://news.example.com/2026/09/25/city-council-approves-river-park';
const ALLOWED: RobotsDecision = { allowed: true, reason: 'allowed' };

type Route =
  | { redirectTo: string; status?: number }
  | { page: { status?: number; headers?: Record<string, string>; body: Uint8Array | string } }
  | { failure: Omit<Extract<SafeFetchResult, { ok: false }>, 'ok'> };

/**
 * A fake page fetch that behaves like `safeFetch` towards the policy callback: `beforeRequest` runs
 * before every hop (hop 0 included) and a denial ends the chain with `FEED_POLICY_DENIED`.
 */
function fakeFetch(routes: Record<string, Route>) {
  const requested: string[] = [];
  const options: PageFetchOptions[] = [];
  const fetch = vi.fn(
    async (url: string, fetchOptions: PageFetchOptions): Promise<SafeFetchResult> => {
      options.push(fetchOptions);
      const redirects: Array<{ status: number; from: string; to: string }> = [];
      let current = url;
      for (let hop = 0; hop <= 5; hop += 1) {
        const verdict = await fetchOptions.beforeRequest(new URL(current), hop);
        if (verdict !== true) {
          return {
            ok: false,
            code: 'FEED_POLICY_DENIED',
            message: 'the request was denied by policy',
            finalUrl: current,
            redirects,
            policy: verdict,
          };
        }
        requested.push(current);
        const route = routes[current];
        if (route === undefined) {
          return {
            ok: false,
            code: 'FEED_HTTP_404',
            status: 404,
            message: 'HTTP 404',
            finalUrl: current,
          };
        }
        if ('redirectTo' in route) {
          redirects.push({ status: route.status ?? 301, from: current, to: route.redirectTo });
          current = route.redirectTo;
          continue;
        }
        if ('failure' in route) return { ok: false, finalUrl: current, ...route.failure };
        const body = route.page.body;
        return {
          ok: true,
          status: route.page.status ?? 200,
          finalUrl: current,
          permanentRedirect: redirects.length > 0 && redirects.every((r) => r.status === 301),
          redirects,
          headers: route.page.headers ?? { 'content-type': 'text/html; charset=utf-8' },
          bodyBytes: typeof body === 'string' ? new TextEncoder().encode(body) : body,
        };
      }
      return { ok: false, code: 'FEED_TOO_MANY_REDIRECTS', message: 'too many redirects' };
    },
  );
  return { fetch, requested, options };
}

/** A robots checker answering per URL prefix (default: allowed) and recording every check. */
function fakeRobots(rules: Array<[prefix: string, decision: RobotsDecision]> = []) {
  const checked: string[] = [];
  const robots: RobotsChecker = {
    check: vi.fn(async (url: URL) => {
      checked.push(url.href);
      return rules.find(([prefix]) => url.href.startsWith(prefix))?.[1] ?? ALLOWED;
    }),
  };
  return { robots, checked };
}

const htmlPage = (name: string, contentType = 'text/html; charset=utf-8'): Route => ({
  page: { headers: { 'content-type': contentType }, body: readFixture('pages', name) },
});

function deps(
  fetch: ExtractDeps['fetch'],
  robots: RobotsChecker,
  extra: Partial<ExtractDeps> = {},
): ExtractDeps {
  return { fetch, robots, ...extra };
}

describe('spec 03 §8.1 extractArticle', () => {
  it('fetches, follows redirects and extracts the article', async () => {
    const wrapper = 'https://feeds.example.net/r/4821';
    const { fetch, requested, options } = fakeFetch({
      [wrapper]: { redirectTo: ARTICLE_URL },
      [ARTICLE_URL]: htmlPage('article.html'),
    });
    const { robots, checked } = fakeRobots();
    const result = await extractArticle(wrapper, deps(fetch, robots));

    expect(result).toMatchObject({
      status: 'ok',
      resolvedUrl: ARTICLE_URL,
      httpStatus: 200,
      completeness: 'complete',
      completenessReason: null,
      canonicalUrl: ARTICLE_URL,
      wordCount: 600,
      error: null,
      deferUntil: null,
      videoEvidence: false,
      bodyImageCount: 1,
    });
    expect(result.bodyText).toContain('The Riverton city council voted 7 to 2');
    expect(result.bodyHtml).toContain('<p>');
    expect(result.bodyLead?.endsWith('built from the old loading platforms.')).toBe(true);
    expect(requested).toEqual([wrapper, ARTICLE_URL]);
    expect(options[0]?.purpose).toBe('page');
    // The article URL before fetching, then each redirect destination through beforeRequest.
    expect(checked).toEqual([wrapper, ARTICLE_URL]);
    expect(EXTRACTOR_VERSION).toBe('readability-v1');
  });

  it('decodes a windows-1250 page from its <meta charset> when the header has no charset', async () => {
    const url = 'https://www.example.sk/spravy/2026/09/26/nova-cyklotrasa-pozdlz-dunaja';
    const { fetch } = fakeFetch({ [url]: htmlPage('windows-1250.html', 'text/html') });
    const result = await extractArticle(url, deps(fetch, fakeRobots().robots));
    expect(result).toMatchObject({ status: 'ok', completeness: 'complete', wordCount: 296 });
    expect(result.bodyText).toContain(
      'Petržalku so Starým Mestom a pokračuje pozdĺž ľavého brehu Dunaja',
    );
    expect(result.bodyText).not.toContain('�');
    expect(result.bodyLead?.endsWith('upozornilo však na niekoľko nedostatkov.')).toBe(true);
  });

  it('reports the paywall teaser, the AMP canonical and the list page', async () => {
    const paywallUrl = 'https://www.example.org/business/2026/09/24/chipmaker-second-plant';
    const ampUrl = 'https://www.example.com/science/2026/09/22/comet-arden-green-tail/amp';
    const listUrl = 'https://news.example.com/politics/';
    const { fetch } = fakeFetch({
      [paywallUrl]: htmlPage('paywall-teaser.html'),
      [ampUrl]: htmlPage('amp-article.html'),
      [listUrl]: htmlPage('list-page.html'),
    });
    const { robots } = fakeRobots();
    await expect(extractArticle(paywallUrl, deps(fetch, robots))).resolves.toMatchObject({
      status: 'ok',
      completeness: 'partial',
      completenessReason: 'paywall',
      wordCount: 85,
    });
    await expect(extractArticle(ampUrl, deps(fetch, robots))).resolves.toMatchObject({
      status: 'ok',
      resolvedUrl: ampUrl,
      canonicalUrl: 'https://www.example.com/science/2026/09/22/comet-arden-green-tail',
      wordCount: 233,
    });
    await expect(extractArticle(listUrl, deps(fetch, robots))).resolves.toMatchObject({
      status: 'failed',
      resolvedUrl: listUrl,
      httpStatus: 200,
      error: 'no_content',
      completenessReason: 'no_content',
      bodyText: null,
    });
  });

  it('skips skip-list URLs without robots or fetch', async () => {
    const { fetch } = fakeFetch({});
    const { robots, checked } = fakeRobots();
    // A skipped URL on a VIDEO_HOSTS host is video evidence (spec 03 §8.1 steps 1 and 6).
    await expect(
      extractArticle('https://m.youtube.com/watch?v=x', deps(fetch, robots)),
    ).resolves.toEqual({
      status: 'skipped',
      resolvedUrl: null,
      httpStatus: null,
      bodyText: null,
      bodyHtml: null,
      bodyLead: null,
      wordCount: null,
      completeness: 'partial',
      completenessReason: 'skip_host',
      canonicalUrl: null,
      error: null,
      deferUntil: null,
      videoEvidence: true,
      bodyImageCount: null,
    });
    for (const video of [
      'https://youtu.be/tr4mR3st0r3',
      'https://vimeo.com/123456789',
      'https://www.TikTok.com./@workshop/video/7412',
    ]) {
      await expect(extractArticle(video, deps(fetch, robots))).resolves.toMatchObject({
        status: 'skipped',
        completenessReason: 'skip_host',
        videoEvidence: true,
        bodyImageCount: null,
      });
    }
    // Other skips are no video evidence: social and audio hosts, files, and enclosures (whose
    // video type is feed evidence already).
    for (const [url, reason, enclosureType] of [
      ['https://x.com/valley/status/1', 'skip_host', null],
      ['https://open.spotify.com/episode/1', 'skip_host', null],
      ['https://www.facebook.com/valley/videos/1', 'skip_host', null],
      ['https://example.com/a.PDF', 'skip_extension', null],
      ['https://www.dailymotion.com/cdn/x8abcd.mp4', 'skip_extension', null],
      ['https://cdn.example.com/ep/12', 'skip_media', 'audio/mpeg'],
      ['https://cdn.example.com/ep/13', 'skip_media', 'video/mp4'],
    ] as const) {
      await expect(
        extractArticle(url, deps(fetch, robots), { enclosureType }),
      ).resolves.toMatchObject({
        status: 'skipped',
        completenessReason: reason,
        videoEvidence: false,
        bodyImageCount: null,
      });
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(checked).toEqual([]);
  });

  it('reports the media signals of the fetched page body', async () => {
    const tram = 'https://news.example.com/2026/09/24/tram-restoration';
    const market = 'https://news.example.com/2026/09/26/market-hall-reopens';
    const { fetch } = fakeFetch({
      [tram]: htmlPage('video-youtube.html'),
      [market]: htmlPage('lazy-images.html'),
    });
    const { robots } = fakeRobots();
    await expect(extractArticle(tram, deps(fetch, robots))).resolves.toMatchObject({
      status: 'ok',
      resolvedUrl: tram,
      videoEvidence: true,
      bodyImageCount: 0,
    });
    await expect(extractArticle(market, deps(fetch, robots))).resolves.toMatchObject({
      status: 'ok',
      resolvedUrl: market,
      videoEvidence: false,
      bodyImageCount: 2,
    });
  });

  it('blocks a robots.txt disallow before fetching', async () => {
    const { fetch } = fakeFetch({ [ARTICLE_URL]: htmlPage('article.html') });
    const { robots } = fakeRobots([
      ['https://news.example.com/', { allowed: false, reason: 'disallowed' }],
    ]);
    await expect(extractArticle(ARTICLE_URL, deps(fetch, robots))).resolves.toMatchObject({
      status: 'blocked',
      resolvedUrl: null,
      completeness: 'partial',
      completenessReason: 'robots',
      error: 'robots_disallowed',
      bodyText: null,
      deferUntil: null,
      videoEvidence: false,
      bodyImageCount: null,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('blocks when robots.txt disallows a redirect destination, without requesting it', async () => {
    const wrapper = 'https://feeds.example.net/r/1';
    const { fetch, requested } = fakeFetch({
      [wrapper]: { redirectTo: ARTICLE_URL, status: 302 },
      [ARTICLE_URL]: htmlPage('article.html'),
    });
    const { robots } = fakeRobots([
      ['https://news.example.com/', { allowed: false, reason: 'disallowed' }],
    ]);
    await expect(extractArticle(wrapper, deps(fetch, robots))).resolves.toMatchObject({
      status: 'blocked',
      resolvedUrl: ARTICLE_URL,
      completenessReason: 'robots',
      error: 'robots_disallowed',
    });
    expect(requested).toEqual([wrapper]);
  });

  it('disallows the attempt when robots.txt is unreachable', async () => {
    const { fetch } = fakeFetch({ [ARTICLE_URL]: htmlPage('article.html') });
    const { robots } = fakeRobots([
      ['https://news.example.com/', { allowed: false, reason: 'unreachable' }],
    ]);
    await expect(extractArticle(ARTICLE_URL, deps(fetch, robots))).resolves.toMatchObject({
      status: 'blocked',
      completenessReason: 'robots',
      error: 'robots_unreachable',
    });
  });

  it('defers instead of failing while robots.txt reports an origin cooldown', async () => {
    const retryAt = new Date('2026-09-26T12:00:00Z');
    const cooldown: RobotsDecision = { allowed: false, reason: 'cooldown', retryAt };
    const wrapper = 'https://feeds.example.net/r/2';
    const { fetch } = fakeFetch({ [wrapper]: { redirectTo: ARTICLE_URL } });
    const { robots } = fakeRobots([['https://news.example.com/', cooldown]]);
    await expect(extractArticle(ARTICLE_URL, deps(fetch, robots))).resolves.toMatchObject({
      status: 'failed',
      completenessReason: 'cooldown',
      error: 'robots_cooldown',
      deferUntil: retryAt,
    });
    await expect(extractArticle(wrapper, deps(fetch, robots))).resolves.toMatchObject({
      resolvedUrl: ARTICLE_URL,
      error: 'robots_cooldown',
      deferUntil: retryAt,
    });
    const noRetryAt = fakeRobots([
      ['https://news.example.com/', { allowed: false, reason: 'cooldown' }],
    ]);
    await expect(
      extractArticle(ARTICLE_URL, deps(fetch, noRetryAt.robots, { now: () => 1_000_000 })),
    ).resolves.toMatchObject({ deferUntil: new Date(1_060_000) });
  });

  it('skips a redirect to a URL on the skip list', async () => {
    const wrapper = 'https://feeds.example.net/r/3';
    const video = 'https://www.youtube.com/watch?v=abc';
    const { fetch, requested } = fakeFetch({ [wrapper]: { redirectTo: video } });
    await expect(extractArticle(wrapper, deps(fetch, fakeRobots().robots))).resolves.toMatchObject({
      status: 'skipped',
      resolvedUrl: video,
      completenessReason: 'skip_host',
      error: null,
      // The skipped destination is on a video host: video evidence.
      videoEvidence: true,
      bodyImageCount: null,
    });
    expect(requested).toEqual([wrapper]);

    const social = 'https://feeds.example.net/r/4';
    const post = 'https://x.com/valley/status/1';
    const other = fakeFetch({ [social]: { redirectTo: post } });
    await expect(
      extractArticle(social, deps(other.fetch, fakeRobots().robots)),
    ).resolves.toMatchObject({
      status: 'skipped',
      resolvedUrl: post,
      completenessReason: 'skip_host',
      videoEvidence: false,
    });
  });

  it('defers on an origin cooldown or a 429/503 with retryAt', async () => {
    const retryAt = new Date('2026-09-26T13:00:00Z');
    const cases: Array<[Route, string]> = [
      [
        { failure: { code: 'FEED_ORIGIN_COOLDOWN', message: 'cooling down', retryAt } },
        'FEED_ORIGIN_COOLDOWN',
      ],
      [
        { failure: { code: 'FEED_HTTP_429', status: 429, message: 'HTTP 429', retryAt } },
        'FEED_HTTP_429',
      ],
      [
        { failure: { code: 'FEED_HTTP_503', status: 503, message: 'HTTP 503', retryAt } },
        'FEED_HTTP_503',
      ],
    ];
    for (const [route, code] of cases) {
      const { fetch } = fakeFetch({ [ARTICLE_URL]: route });
      await expect(
        extractArticle(ARTICLE_URL, deps(fetch, fakeRobots().robots)),
      ).resolves.toMatchObject({
        status: 'failed',
        completenessReason: 'cooldown',
        error: code,
        deferUntil: retryAt,
        videoEvidence: false,
        bodyImageCount: null,
      });
    }
    const { fetch } = fakeFetch({
      [ARTICLE_URL]: { failure: { code: 'FEED_ORIGIN_COOLDOWN', message: 'busy' } },
    });
    await expect(
      extractArticle(ARTICLE_URL, deps(fetch, fakeRobots().robots, { now: () => 5000 })),
    ).resolves.toMatchObject({ deferUntil: new Date(65_000) });
  });

  it('keeps bounded fetch error codes', async () => {
    const cases: Array<[Route, Partial<Record<string, unknown>>]> = [
      [
        { failure: { code: 'FEED_HTTP_404', status: 404, message: 'HTTP 404' } },
        {
          status: 'failed',
          error: 'FEED_HTTP_404',
          httpStatus: 404,
          completenessReason: 'fetch_failed',
        },
      ],
      [
        { failure: { code: 'FEED_TIMEOUT', message: 'timeout' } },
        { status: 'failed', error: 'FEED_TIMEOUT', httpStatus: null, resolvedUrl: ARTICLE_URL },
      ],
      [
        { failure: { code: 'FEED_TOO_LARGE', message: 'too large' } },
        { status: 'too_large', error: 'FEED_TOO_LARGE', completenessReason: 'too_large' },
      ],
      [
        {
          failure: {
            code: 'FEED_POLICY_DENIED',
            message: 'denied',
            policy: { code: 'custom', message: 'x' },
          },
        },
        { status: 'failed', error: 'custom' },
      ],
      [
        { failure: { code: 'FEED_POLICY_DENIED', message: 'denied' } },
        { status: 'failed', error: 'FEED_POLICY_DENIED' },
      ],
      [
        { page: { status: 304, body: '' } },
        { status: 'failed', error: 'FEED_HTTP_304', httpStatus: 304 },
      ],
    ];
    for (const [route, expected] of cases) {
      const { fetch } = fakeFetch({ [ARTICLE_URL]: route });
      await expect(
        extractArticle(ARTICLE_URL, deps(fetch, fakeRobots().robots)),
      ).resolves.toMatchObject({
        deferUntil: null,
        bodyText: null,
        videoEvidence: false,
        bodyImageCount: null,
        ...expected,
      });
    }
  });

  it('reports not_html for non-HTML content types and untyped binary bodies', async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
    const html = readFixture('pages', 'article.html');
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, 0x0a, 0x20, ...html]);
    const cases: Array<[Record<string, string>, Uint8Array, string]> = [
      [{ 'content-type': 'application/pdf' }, pdf, 'not_html'],
      [{ 'content-type': 'text/plain; charset=utf-8' }, html, 'not_html'],
      [{ 'content-type': 'image/jpeg' }, pdf, 'not_html'],
      [{}, pdf, 'not_html'],
      [{}, html, 'ok'],
      [{ 'content-type': '' }, withBom, 'ok'],
      [{ 'content-type': 'APPLICATION/XHTML+XML; charset=UTF-8' }, html, 'ok'],
    ];
    for (const [headers, body, status] of cases) {
      const { fetch } = fakeFetch({ [ARTICLE_URL]: { page: { headers, body } } });
      const result = await extractArticle(ARTICLE_URL, deps(fetch, fakeRobots().robots));
      expect(result.status).toBe(status);
      if (status === 'not_html') {
        expect(result).toMatchObject({
          resolvedUrl: ARTICLE_URL,
          httpStatus: 200,
          completenessReason: 'not_html',
          videoEvidence: false,
          bodyImageCount: null,
        });
      }
    }
  });

  it('reports a body that decodeBody cannot decode', async () => {
    const { fetch } = fakeFetch({ [ARTICLE_URL]: htmlPage('article.html', 'text/html') });
    decoding.fails = true;
    try {
      await expect(
        extractArticle(ARTICLE_URL, deps(fetch, fakeRobots().robots)),
      ).resolves.toMatchObject({
        status: 'failed',
        resolvedUrl: ARTICLE_URL,
        httpStatus: 200,
        completenessReason: 'decode_failed',
        error: 'FEED_DECODE_ERROR',
        bodyText: null,
      });
    } finally {
      decoding.fails = false;
    }
  });

  it('passes the output cap through', async () => {
    const { fetch } = fakeFetch({ [ARTICLE_URL]: htmlPage('article.html') });
    await expect(
      extractArticle(ARTICLE_URL, deps(fetch, fakeRobots().robots, { maxOutputBytes: 1500 })),
    ).resolves.toMatchObject({ status: 'ok', completenessReason: 'truncated', bodyHtml: null });
  });

  it('reports invalid and non-http URLs without robots or fetch', async () => {
    const { fetch } = fakeFetch({});
    const { robots, checked } = fakeRobots();
    await expect(extractArticle('not a url', deps(fetch, robots))).resolves.toMatchObject({
      status: 'failed',
      error: 'FEED_INVALID_URL',
      videoEvidence: false,
    });
    await expect(extractArticle('ftp://example.com/a', deps(fetch, robots))).resolves.toMatchObject(
      {
        status: 'failed',
        error: 'FEED_INVALID_URL',
      },
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(checked).toEqual([]);
  });

  it('rejects when an injected dependency rejects (an infrastructure fault the caller retries)', async () => {
    const { robots } = fakeRobots();
    // A page fetch whose origin limiter cannot reach PostgreSQL rejects instead of resolving.
    const outage = new Error('origin limiter: connection terminated');
    const throwingFetch: ExtractDeps['fetch'] = () => Promise.reject(outage);
    await expect(extractArticle(ARTICLE_URL, deps(throwingFetch, robots))).rejects.toBe(outage);

    const throwingRobots: RobotsChecker = { check: () => Promise.reject(new Error('boom')) };
    const { fetch } = fakeFetch({ [ARTICLE_URL]: htmlPage('article.html') });
    await expect(extractArticle(ARTICLE_URL, deps(fetch, throwingRobots))).rejects.toThrow('boom');
    expect(fetch).not.toHaveBeenCalled();

    // The robots check of a redirect destination runs inside the fetch and rejects it the same way.
    const wrapper = 'https://feeds.example.net/r/5';
    const hop = fakeFetch({ [wrapper]: { redirectTo: ARTICLE_URL } });
    const flakyRobots: RobotsChecker = {
      check: (url: URL) =>
        url.href === wrapper ? Promise.resolve(ALLOWED) : Promise.reject(new Error('robots store')),
    };
    await expect(extractArticle(wrapper, deps(hop.fetch, flakyRobots))).rejects.toThrow(
      'robots store',
    );
  });

  it('turns a failure of the local work into failed with extraction_failed', async () => {
    const { fetch } = fakeFetch({ [ARTICLE_URL]: htmlPage('article.html') });
    decoding.throws = true;
    try {
      await expect(
        extractArticle(ARTICLE_URL, deps(fetch, fakeRobots().robots)),
      ).resolves.toMatchObject({
        status: 'failed',
        resolvedUrl: ARTICLE_URL,
        httpStatus: 200,
        completenessReason: 'extraction_failed',
        error: 'extraction_failed',
        bodyText: null,
        videoEvidence: false,
        bodyImageCount: null,
        deferUntil: null,
      });
    } finally {
      decoding.throws = false;
    }
  });
});
