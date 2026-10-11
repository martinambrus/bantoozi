import { STARTER_BUNDLES } from '@bantoozi/shared';
import { startFixtureServer, type FixtureServer } from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  checkBundlesLive,
  renderMarkdown,
  validateBundles,
  type BundleFeed,
} from '../src/bundles-check.js';

const rss = (title: string, items: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${title}</title>` +
  `<link>https://example.com/</link><description>d</description>` +
  items
    .map(
      (text, index) =>
        `<item><title>${text}</title><link>https://example.com/a/${index}</link>` +
        `<guid>g${index}</guid><description>${text}</description></item>`,
    )
    .join('') +
  `</channel></rss>`;

const ENGLISH = [
  'The government announced a new plan to improve public transport across the country',
  'Researchers found that the new method significantly reduces energy use in large buildings',
  'The company said that it will release the next version of its software later this year',
];
const SLOVAK = [
  'Vláda oznámila nový plán na zlepšenie verejnej dopravy v celej krajine počas nasledujúcich rokov',
  'Vedci zistili, že nová metóda výrazne znižuje spotrebu energie vo veľkých budovách na Slovensku',
  'Spoločnosť uviedla, že novú verziu svojho softvéru vydá ešte v tomto roku pre všetkých zákazníkov',
];

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer();
  server.route('/en.xml', {
    body: rss('EN', ENGLISH),
    headers: { 'content-type': 'application/rss+xml' },
  });
  server.route('/sk.xml', {
    body: rss('SK', SLOVAK),
    headers: { 'content-type': 'application/rss+xml' },
  });
  server.route('/gone.xml', { status: 404, body: 'nope' });
  server.route('/html.xml', {
    body: '<html><body>not a feed</body></html>',
    headers: { 'content-type': 'text/html' },
  });
});

afterAll(async () => {
  await server.close();
});

describe('validateBundles', () => {
  it('accepts the shipped starter bundles', () => {
    expect(validateBundles(STARTER_BUNDLES)).toEqual([]);
  });

  it('reports http addresses, duplicates and a missing lang', () => {
    const problems = validateBundles([
      {
        id: 'x',
        names: { en: 'x', sk: 'x' },
        urls: ['http://a.example/feed', 'https://b.example/feed', 'https://b.example/feed'],
        feeds: [
          { url: 'http://a.example/feed', lang: 'en' },
          { url: 'https://b.example/feed', lang: 'en' },
          { url: 'https://b.example/feed', lang: 'de' as 'en' },
        ],
      },
    ]);
    expect(problems.join('\n')).toMatch(/https/);
    expect(problems.join('\n')).toMatch(/duplicate/i);
    expect(problems.join('\n')).toMatch(/lang/);
  });
});

describe('checkBundlesLive (local fixture server, no internet)', () => {
  it('reports ok, failed, not-a-feed and lang-mismatch', async () => {
    const feeds: BundleFeed[] = [
      { bundle: 't', url: server.url('/en.xml'), lang: 'en' },
      { bundle: 't', url: server.url('/sk.xml'), lang: 'sk' },
      { bundle: 't', url: server.url('/sk.xml?x=1'), lang: 'en' },
      { bundle: 't', url: server.url('/gone.xml'), lang: 'en' },
      { bundle: 't', url: server.url('/html.xml'), lang: 'en' },
    ];
    const report = await checkBundlesLive(feeds, {
      userAgent: 'BantooziBot/1.0 (+http://localhost/bot)',
      allowPrivate: true,
      timeoutMs: 5_000,
    });
    expect(report.results.map((result) => result.status)).toEqual([
      'ok',
      'ok',
      'lang-mismatch',
      'failed',
      'failed',
    ]);
    expect(report.results[0]).toMatchObject({ items: 3, detectedLang: 'en', httpStatus: 200 });
    expect(report.results[2]).toMatchObject({ detectedLang: 'sk', declaredLang: 'en' });
    expect(report.results[3]?.code).toBe('FEED_HTTP_404');
    expect(report.summary).toEqual({ total: 5, ok: 2, failed: 2, langMismatch: 1 });
    const markdown = renderMarkdown(report);
    expect(markdown).toContain('lang-mismatch');
    expect(markdown).toContain('FEED_HTTP_404');
  });
});
