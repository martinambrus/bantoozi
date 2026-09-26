import { fixturePath, startFixtureServer, type FixtureServer } from '@bantoozi/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createMemoryOriginLimiter,
  createRobotsChecker,
  extractArticle,
  type ExtractDeps,
} from '../../src/extract/index.js';
import { safeFetch, type SafeFetchOptions } from '../../src/http/index.js';

const USER_AGENT = 'BantooziBot/1.0 (+http://localhost/bot)';
const ROBOTS = [
  'User-agent: *',
  'Disallow: /private/',
  '',
  'User-agent: BantooziBot',
  'Disallow: /members/',
  '',
].join('\n');

let server: FixtureServer;

/**
 * The worker's wiring: robots and pages both go through the real `safeFetch` (FETCH_ALLOW_PRIVATE
 * for the loopback fixture server) and one shared in-memory politeness limiter.
 */
function wire(): ExtractDeps {
  const shared: Omit<SafeFetchOptions, 'purpose'> = {
    userAgent: USER_AGENT,
    timeoutMs: 5_000,
    maxBytes: 5 * 1024 * 1024,
    allowPrivate: true,
    limiter: createMemoryOriginLimiter({ spacingMs: 20 }),
  };
  return {
    fetch: (url, options) => safeFetch(url, { ...shared, ...options }),
    robots: createRobotsChecker({
      fetch: (url, purpose) => safeFetch(url, { ...shared, purpose }),
    }),
  };
}

const requestedPaths = (): string[] => server.requests.map((request) => request.path);

beforeAll(async () => {
  server = await startFixtureServer({ root: fixturePath('pages') });
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  server.reset();
  server.route('/robots.txt', { headers: { 'content-type': 'text/plain' }, body: ROBOTS });
});

describe('spec 03 §8.1 extraction over the real safeFetch and a fixture server', () => {
  it('follows a redirect, checks robots once per origin and extracts the article', async () => {
    server.redirect('/go/park', '/article.html', 302);
    const deps = wire();
    const result = await extractArticle(server.url('/go/park'), deps);
    expect(result).toMatchObject({
      status: 'ok',
      resolvedUrl: server.url('/article.html'),
      httpStatus: 200,
      completeness: 'complete',
      wordCount: 600,
      // The fixture's canonical names news.example.com, another site than the loopback server.
      canonicalUrl: null,
      deferUntil: null,
    });
    expect(result.bodyLead?.endsWith('built from the old loading platforms.')).toBe(true);

    await expect(extractArticle(server.url('/amp-article.html'), deps)).resolves.toMatchObject({
      status: 'ok',
      wordCount: 233,
    });
    expect(requestedPaths()).toEqual([
      '/robots.txt',
      '/go/park',
      '/article.html',
      '/amp-article.html',
    ]);
    const page = server.requests.find((request) => request.path === '/article.html');
    expect(page?.headers['user-agent']).toBe(USER_AGENT);
    expect(page?.headers['accept']).toBe('text/html,application/xhtml+xml');
  });

  it('decodes the windows-1250 page from <meta charset>', async () => {
    server.route('/sk/cyklotrasa', {
      file: 'windows-1250.html',
      headers: { 'content-type': 'text/html' },
    });
    const result = await extractArticle(server.url('/sk/cyklotrasa'), wire());
    expect(result).toMatchObject({ status: 'ok', wordCount: 296 });
    expect(result.bodyText).toContain('pokračuje pozdĺž ľavého brehu Dunaja až do Devína');
  });

  it('reports the paywall teaser and the list page', async () => {
    const deps = wire();
    await expect(extractArticle(server.url('/paywall-teaser.html'), deps)).resolves.toMatchObject({
      status: 'ok',
      completeness: 'partial',
      completenessReason: 'paywall',
      wordCount: 85,
    });
    await expect(extractArticle(server.url('/list-page.html'), deps)).resolves.toMatchObject({
      status: 'failed',
      error: 'no_content',
    });
  });

  it('blocks a robots.txt disallow, also on a redirect destination, without requesting it', async () => {
    server.redirect('/go/members', '/members/story.html', 301);
    server.route('/members/story.html', { file: 'article.html' });
    const deps = wire();
    await expect(extractArticle(server.url('/members/story.html'), deps)).resolves.toMatchObject({
      status: 'blocked',
      completenessReason: 'robots',
      error: 'robots_disallowed',
    });
    await expect(extractArticle(server.url('/go/members'), deps)).resolves.toMatchObject({
      status: 'blocked',
      resolvedUrl: server.url('/members/story.html'),
      error: 'robots_disallowed',
    });
    expect(requestedPaths()).toEqual(['/robots.txt', '/go/members']);
  });

  it('treats a missing robots.txt as allow-all and an erroring one as unreachable', async () => {
    server.route('/robots.txt', { status: 404, body: 'not found' });
    await expect(extractArticle(server.url('/article.html'), wire())).resolves.toMatchObject({
      status: 'ok',
    });
    server.reset();
    server.route('/robots.txt', { status: 500, body: 'oops' });
    await expect(extractArticle(server.url('/article.html'), wire())).resolves.toMatchObject({
      status: 'blocked',
      error: 'robots_unreachable',
    });
    expect(requestedPaths()).toEqual(['/robots.txt']);
  });

  it('reports not_html for a PDF served under an article-like path', async () => {
    server.route('/files/report', {
      headers: { 'content-type': 'application/pdf' },
      body: '%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n',
    });
    await expect(extractArticle(server.url('/files/report'), wire())).resolves.toMatchObject({
      status: 'not_html',
      httpStatus: 200,
      resolvedUrl: server.url('/files/report'),
    });
  });

  it('defers on 429 and then on the persisted origin cooldown', async () => {
    server.route('/busy.html', {
      status: 429,
      headers: { 'retry-after': '120' },
      body: 'slow down',
    });
    const deps = wire();
    const before = Date.now();
    const first = await extractArticle(server.url('/busy.html'), deps);
    expect(first).toMatchObject({ status: 'failed', error: 'FEED_HTTP_429', httpStatus: 429 });
    const deferUntil = first.deferUntil?.getTime() ?? 0;
    expect(deferUntil).toBeGreaterThanOrEqual(before + 119_000);
    expect(deferUntil).toBeLessThanOrEqual(Date.now() + 121_000);

    const second = await extractArticle(server.url('/article.html'), deps);
    expect(second).toMatchObject({
      status: 'failed',
      error: 'FEED_ORIGIN_COOLDOWN',
      completenessReason: 'cooldown',
    });
    expect(second.deferUntil?.getTime()).toBe(deferUntil);
    expect(requestedPaths()).toEqual(['/robots.txt', '/busy.html']);
  });
});
