import { Readability } from '@mozilla/readability';
import { readFixture } from '@bantoozi/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BODY_LEAD_MAX_CHARS, extractFromHtml } from '../../src/extract/index.js';
import { decodeBody } from '../../src/http/index.js';
import { mediaSignals } from '../../src/media/index.js';

const chars = (text: string | null): number => Array.from(text ?? '').length;
const bytes = (text: string | null): number => Buffer.byteLength(text ?? '', 'utf8');
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** The decoded text of a page fixture (charset handling as in `extractArticle`). */
function fixtureHtml(name: string): string {
  const decoded = decodeBody(readFixture('pages', name), 'text/html');
  if (!decoded.ok) throw new Error(`cannot decode ${name}`);
  return decoded.text;
}

/** Tags of sanitized HTML are balanced and no tag is cut. */
function expectWellFormed(html: string): void {
  expect(html).not.toMatch(/<[^>]*$/);
  const stack: string[] = [];
  for (const match of html.matchAll(/<(\/?)([a-z0-9-]+)[^>]*?(\/?)>/gi)) {
    const [, closing, name = '', selfClosing] = match;
    const tag = name.toLowerCase();
    if (selfClosing === '/' || tag === 'br') continue;
    if (closing === '/') expect(stack.pop()).toBe(tag);
    else stack.push(tag);
  }
  expect(stack).toEqual([]);
}

const PARAGRAPHS = [
  'The regional water authority announced on Monday that it will replace more than forty kilometres of lead pipes in the old town over the next three years, starting with the streets around the main square.',
  'Engineers say the work will be done one street at a time, so that no household loses its water supply for more than a few hours. Residents will receive a letter two weeks before work begins on their street.',
  'The project will cost about 26 million euros, most of which will come from a national programme for safer drinking water. The authority will cover the rest from its own reserves without raising prices.',
  'Tests carried out last year found lead levels above the legal limit in water from eleven buildings, all of them built before 1930. The authority has since supplied those households with bottled water.',
  'The mayor welcomed the plan and said the city would use the opportunity to repair the pavements and add trees along several streets once the new pipes are in place.',
];

/** A news article page with optional extra head markup, body attributes and trailing markup. */
function articlePage(
  options: { head?: string; bodyAttributes?: string; paragraphs?: string[]; after?: string } = {},
): string {
  const paragraphs = (options.paragraphs ?? PARAGRAPHS).map((text) => `<p>${text}</p>`).join('\n');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Water authority to replace lead pipes</title>${options.head ?? ''}</head>
<body ${options.bodyAttributes ?? ''}><header><nav><a href="/">Home</a> <a href="/news/">News</a></nav></header>
<main><article><h1>Water authority to replace lead pipes</h1>
${paragraphs}
${options.after ?? ''}
</article></main><footer><p>© 2026 The Valley Gazette</p></footer></body></html>`;
}

const PAGE_URL = 'https://news.example.com/2026/09/26/lead-pipes';

describe('spec 03 §8.1 steps 5–6 extractFromHtml — page fixtures', () => {
  it('extracts the normal article: complete, paragraphs kept, sanitized, sentence-cut lead', () => {
    const url = 'https://news.example.com/2026/09/25/city-council-approves-river-park';
    const result = extractFromHtml(fixtureHtml('article.html'), url);
    expect(result).toMatchObject({
      status: 'ok',
      completeness: 'complete',
      completenessReason: null,
      canonicalUrl: url,
      error: null,
      wordCount: 600,
      // The figure counts; the 1×1 pixel at the end of the article does not.
      videoEvidence: false,
      bodyImageCount: 1,
    });
    const text = result.bodyText ?? '';
    expect(text).toContain(
      'The Riverton city council voted 7 to 2 on Wednesday night to turn the disused rail yard',
    );
    expect(text).toContain("submit questions in advance through the city's website.");
    expect(text).toContain('in the summer of 2028.\n\nThe eleven-hectare site');
    for (const boilerplate of [
      'Most read',
      'All rights reserved',
      'Finally! I have been waiting',
      'Share this article',
      'Politics',
    ]) {
      expect(text).not.toContain(boilerplate);
    }

    const html = result.bodyHtml ?? '';
    expect(html).toContain(
      '<a href="https://news.example.com/2026/08/12/budget-vote" rel="noopener noreferrer nofollow" target="_blank">last month\'s budget vote</a>',
    );
    for (const unsafe of [
      '<script',
      '<img',
      'onclick',
      'javascript:',
      'pixel.example.net',
      'srcset',
    ]) {
      expect(html).not.toContain(unsafe);
    }

    const lead = result.bodyLead ?? '';
    expect(chars(lead)).toBe(1448);
    expect(chars(lead)).toBeLessThanOrEqual(BODY_LEAD_MAX_CHARS);
    expect(chars(lead)).toBeGreaterThan(1000);
    expect(text.startsWith(lead)).toBe(true);
    expect(lead.endsWith('built from the old loading platforms.')).toBe(true);
  });

  it('parses inertly: page scripts never run', () => {
    extractFromHtml(fixtureHtml('article.html'), 'https://news.example.com/a');
    expect((globalThis as Record<string, unknown>)['__bantooziScriptRan']).toBeUndefined();
  });

  it('produces well-formed sanitized HTML', () => {
    const result = extractFromHtml(fixtureHtml('article.html'), 'https://news.example.com/a');
    expect(result.bodyHtml).not.toContain('bantoozi-unwrap');
    expectWellFormed(result.bodyHtml ?? '');
  });

  it('marks the paywall teaser partial and keeps only the available text', () => {
    const url = 'https://www.example.org/business/2026/09/24/chipmaker-second-plant';
    const result = extractFromHtml(fixtureHtml('paywall-teaser.html'), url);
    expect(result).toMatchObject({
      status: 'ok',
      completeness: 'partial',
      completenessReason: 'paywall',
      canonicalUrl: url,
      wordCount: 85,
      error: null,
    });
    expect(result.bodyText).toMatch(/^The sensor manufacturer Northlight Semiconductors/);
    expect(result.bodyText).toMatch(/about land, water supplies and$/);
    expect(result.bodyText).not.toContain('Subscribe');
    // The whole teaser fits in the lead: nothing is cut or invented.
    expect(result.bodyLead).toBe(result.bodyText);
    expect(chars(result.bodyLead)).toBe(546);
  });

  it.each([
    'https://www.example.com/science/2026/09/22/comet-arden-green-tail/amp',
    'https://amp.example.com/science/2026/09/22/comet-arden-green-tail',
    'https://www.example.com/amp/science/2026/09/22/comet-arden-green-tail',
  ])('extracts the AMP page %s and accepts its rel=canonical', (url) => {
    const result = extractFromHtml(fixtureHtml('amp-article.html'), url);
    expect(result).toMatchObject({
      status: 'ok',
      completeness: 'complete',
      canonicalUrl: 'https://www.example.com/science/2026/09/22/comet-arden-green-tail',
      wordCount: 233,
    });
    expect(result.bodyText).toContain('The colour comes from diatomic carbon');
    expect(result.bodyText).not.toContain('gtag_id');
    expect(result.bodyLead).toBe(result.bodyText);
    expect(chars(result.bodyLead)).toBe(1333);
  });

  it('rejects the AMP canonical when served from an AMP cache domain', () => {
    const url = 'https://www-example-com.cdn.ampproject.org/c/s/www.example.com/science/comet/amp';
    expect(extractFromHtml(fixtureHtml('amp-article.html'), url).canonicalUrl).toBeNull();
  });

  it('extracts the windows-1250 Slovak page with correct diacritics', () => {
    const url = 'https://www.example.sk/spravy/2026/09/26/nova-cyklotrasa-pozdlz-dunaja';
    const result = extractFromHtml(fixtureHtml('windows-1250.html'), url);
    expect(result).toMatchObject({
      status: 'ok',
      completeness: 'complete',
      canonicalUrl: url,
      wordCount: 296,
    });
    const text = result.bodyText ?? '';
    expect(text).toContain('pokračuje pozdĺž ľavého brehu Dunaja až do Devína');
    expect(text).toContain('„Chceme, aby bol bicykel v Bratislave bežným dopravným prostriedkom');
    expect(text).toContain(
      'Sčítače na Starom moste zaznamenali počas prvého víkendu viac ako jedenásťtisíc prejazdov',
    );
    expect(text).not.toContain('�');
    const lead = result.bodyLead ?? '';
    expect(chars(lead)).toBe(1480);
    expect(lead.endsWith('upozornilo však na niekoľko nedostatkov.')).toBe(true);
    expect(text.startsWith(lead)).toBe(true);
  });

  it('reports no content for the list page, without a canonical', () => {
    const result = extractFromHtml(
      fixtureHtml('list-page.html'),
      'https://news.example.com/politics/',
    );
    expect(result).toEqual({
      status: 'failed',
      bodyText: null,
      bodyHtml: null,
      bodyLead: null,
      wordCount: null,
      completeness: 'partial',
      completenessReason: 'no_content',
      canonicalUrl: null,
      error: 'no_content',
      videoEvidence: false,
      bodyImageCount: null,
    });
  });
});

describe('spec 03 §6.4 media signals of the Readability fragment (M1-T5)', () => {
  it('keeps an embedded YouTube iframe and reports video evidence', () => {
    const url = 'https://news.example.com/2026/09/24/tram-restoration';
    const result = extractFromHtml(fixtureHtml('video-youtube.html'), url);
    expect(result).toMatchObject({
      status: 'ok',
      completeness: 'complete',
      canonicalUrl: url,
      videoEvidence: true,
      // The tracking pixel inside the article is not an in-body image.
      bodyImageCount: 0,
    });
    expect(result.bodyText).toContain('The volunteers filmed every stage of the work');
    // Read before sanitizing: the stored HTML keeps neither the player nor the pixel.
    expect(result.bodyHtml).not.toContain('<iframe');
    expect(result.bodyHtml).not.toContain('youtube');
  });

  it('reports a <video> element as video evidence', () => {
    const url = 'https://www.coastal.example/2026/09/harbour-timelapse/';
    const result = extractFromHtml(fixtureHtml('video-element.html'), url);
    expect(result).toMatchObject({
      status: 'ok',
      canonicalUrl: url,
      videoEvidence: true,
      bodyImageCount: 0,
    });
    expect(result.bodyText).toContain('compressed into ninety seconds');
    expect(result.bodyHtml).not.toContain('<video');
  });

  it('counts lazy images once with their <noscript> fallbacks, never the pixel or other page parts', () => {
    const url = 'https://news.example.com/2026/09/26/market-hall-reopens';
    const html = fixtureHtml('lazy-images.html');
    const result = extractFromHtml(html, url);
    expect(result).toMatchObject({
      status: 'ok',
      completeness: 'complete',
      canonicalUrl: url,
      videoEvidence: false,
      // The glass roof and the stalls: each lazy image and its fallback count once.
      bodyImageCount: 2,
    });
    expect(result.bodyText).toContain('The glass roof lets in three times as much daylight');
    expect(result.bodyText).not.toContain('Related stories');
    expect(result.bodyHtml).not.toContain('<img');
    // The whole page has six images: the logo and three related-story thumbnails lie outside the
    // Readability result and are never counted.
    expect(mediaSignals({ link: null, bodyHtml: html, baseUrl: url }).bodyImageCount).toBe(6);
  });

  it('passes allowedVideoRegex, so players beyond Readability’s default list survive', () => {
    const facebook =
      '<figure><iframe src="https://www.facebook.com/plugins/video.php?height=314&amp;href=https%3A%2F%2Fwww.facebook.com%2Fvalley%2Fvideos%2F1&amp;show_text=false&amp;width=560" width="560" height="314" allowfullscreen="true"></iframe><figcaption>The market on its first morning.</figcaption></figure>';
    expect(extractFromHtml(articlePage({ after: facebook }), PAGE_URL)).toMatchObject({
      status: 'ok',
      videoEvidence: true,
    });
    const tiktok =
      '<div class="embed"><iframe src="https://www.tiktok.com/embed/v2/7412345678901234567" width="325" height="740"></iframe></div>';
    expect(extractFromHtml(articlePage({ after: tiktok }), PAGE_URL).videoEvidence).toBe(true);
    // Other frames are removed by Readability and are no evidence anyway.
    const other =
      '<figure><iframe src="https://www.facebook.com/plugins/post.php?href=x" width="500" height="600"></iframe><figcaption>A post.</figcaption></figure><div><iframe src="https://maps.example.com/embed?q=market" width="600" height="450"></iframe></div>';
    expect(extractFromHtml(articlePage({ after: other }), PAGE_URL)).toMatchObject({
      status: 'ok',
      videoEvidence: false,
      bodyImageCount: 0,
    });
  });

  it('reports video evidence of a fragment too short to store, without an image count', () => {
    const page = `<html><body><article><h1>Watch: the tram is back</h1><p>The restored tram left the depot this morning.</p><figure><iframe src="https://www.youtube-nocookie.com/embed/tr4mR3st0r3" width="640" height="360"></iframe><figcaption>Car 7 on the river line.</figcaption></figure><img src="/still.jpg" alt="Car 7"></article></body></html>`;
    expect(extractFromHtml(page, PAGE_URL)).toMatchObject({
      status: 'failed',
      error: 'no_content',
      bodyText: null,
      videoEvidence: true,
      bodyImageCount: null,
    });
  });

  it('resolves lazy image URLs against the pinned document base', () => {
    const images = [
      // Readability leaves this placeholder and the relative data-src as they are.
      `<figure><img src="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%3E%3C/svg%3E" data-src="photos/a.jpg" alt="A"><figcaption>Photo A of the new pipes.</figcaption></figure>`,
      '<figure><img srcset="photos/b-400.jpg 400w, photos/b-800.jpg 800w" alt="B"><figcaption>Photo B of the trench.</figcaption></figure>',
      '<figure><img src="https://news.example.com/archive/photos/a.jpg" alt="A again"><figcaption>Photo A once more.</figcaption></figure>',
    ].join('');
    const result = extractFromHtml(
      articlePage({ head: '<base href="/archive/">', after: images }),
      PAGE_URL,
    );
    expect(result).toMatchObject({ status: 'ok', bodyImageCount: 2 });
  });
});

describe('spec 03 §8.1 step 6 completeness: paywall and teaser markers', () => {
  it('reports a plain article as complete', () => {
    const result = extractFromHtml(articlePage(), PAGE_URL);
    expect(result).toMatchObject({
      status: 'ok',
      completeness: 'complete',
      completenessReason: null,
    });
    expect(result.bodyText?.split('\n\n')).toHaveLength(PARAGRAPHS.length);
  });

  it.each([
    [
      'JSON-LD isAccessibleForFree "False" inside @graph',
      {
        head: '<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite","name":"x"},{"@type":"NewsArticle","isAccessibleForFree":"False"}]}</script>',
      },
    ],
    [
      'a JSON-LD hasPart web page element',
      {
        head: '<script type="application/ld+json; charset=utf-8"><!--{"@type":"Article","hasPart":[{"@type":"WebPageElement","isAccessibleForFree":false,"cssSelector":".locked"}]}--></script>',
      },
    ],
    [
      'microdata isAccessibleForFree',
      { head: '<meta itemprop="isAccessibleForFree" content="false">' },
    ],
    [
      'a microdata element with text',
      { after: '<span itemprop="isAccessibleForFree" style="display:none">False</span>' },
    ],
    [
      'article:content_tier locked',
      { head: '<meta property="article:content_tier" content="Locked">' },
    ],
    [
      'a visible paywall container',
      { after: '<div class="c-article__paywall">Subscribe to read the rest of this story.</div>' },
    ],
    [
      'a registration wall',
      { after: '<section id="regwall-prompt"><p>Create a free account to continue.</p></section>' },
    ],
  ])('detects %s as a paywall', (_name, options) => {
    expect(extractFromHtml(articlePage(options), PAGE_URL)).toMatchObject({
      status: 'ok',
      completeness: 'partial',
      completenessReason: 'paywall',
    });
  });

  it.each([
    ['a hidden paywall prompt', { after: '<div class="paywall" hidden>Subscribe now</div>' }],
    [
      'a display:none paywall prompt',
      { after: '<div class="paywall" style="color:red; display: none">Subscribe now</div>' },
    ],
    [
      'an aria-hidden paywall prompt',
      { after: '<div class="paywall" aria-hidden="true">Subscribe now</div>' },
    ],
    ['an empty paywall placeholder', { after: '<div id="paywall-container"></div>' }],
    ['a page-wide paywall flag', { bodyAttributes: 'class="has-paywall"' }],
    [
      'a paywall script',
      { head: '<script id="paywall-config">window.meter = {"limit": 5};</script>' },
    ],
    [
      'a free JSON-LD article',
      {
        head: '<script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":true}</script>',
      },
    ],
    [
      'invalid JSON-LD',
      { head: '<script type="application/ld+json">{"isAccessibleForFree": false,,}</script>' },
    ],
    [
      'a metered content tier',
      { head: '<meta property="article:content_tier" content="metered">' },
    ],
  ])('does not treat %s as a paywall', (_name, options) => {
    expect(extractFromHtml(articlePage(options), PAGE_URL)).toMatchObject({
      status: 'ok',
      completeness: 'complete',
      completenessReason: null,
    });
  });

  it('bounds the JSON-LD walk', () => {
    let deep: unknown = { isAccessibleForFree: false };
    for (let level = 0; level < 20; level += 1) deep = { child: deep };
    const head = `<script type="application/ld+json">${JSON.stringify(deep)}</script>`;
    expect(extractFromHtml(articlePage({ head }), PAGE_URL).completeness).toBe('complete');
  });

  it('marks a short result as a teaser', () => {
    const paragraphs = [PARAGRAPHS[0] ?? '', 'The work starts in March.'];
    const result = extractFromHtml(articlePage({ paragraphs }), PAGE_URL);
    expect(chars(result.bodyText)).toBeGreaterThanOrEqual(200);
    expect(chars(result.bodyText)).toBeLessThan(500);
    expect(result).toMatchObject({
      status: 'ok',
      completeness: 'partial',
      completenessReason: 'teaser',
    });
  });

  it.each([
    'The mayor welcomed the plan. Continue reading',
    'The mayor welcomed the plan. Read more »',
    'The mayor welcomed the plan and said…',
    'The mayor welcomed the plan and said [...]',
    'Primátor plán privítal. Čítajte ďalej',
  ])('marks a text ending with a teaser cue as a teaser: %s', (ending) => {
    const paragraphs = [...PARAGRAPHS.slice(0, 4), ending];
    expect(extractFromHtml(articlePage({ paragraphs }), PAGE_URL)).toMatchObject({
      status: 'ok',
      completeness: 'partial',
      completenessReason: 'teaser',
    });
  });

  it('fails with no_content below 200 characters, naming a paywall when marked', () => {
    const paragraphs = ['The regional water authority will replace lead pipes in the old town.'];
    expect(extractFromHtml(articlePage({ paragraphs }), PAGE_URL)).toMatchObject({
      status: 'failed',
      error: 'no_content',
      completenessReason: 'no_content',
      bodyText: null,
      videoEvidence: false,
      bodyImageCount: null,
    });
    const head = '<meta property="article:content_tier" content="locked">';
    expect(extractFromHtml(articlePage({ paragraphs, head }), PAGE_URL)).toMatchObject({
      status: 'failed',
      error: 'no_content',
      completenessReason: 'paywall',
    });
    expect(extractFromHtml('', PAGE_URL)).toMatchObject({ status: 'failed', error: 'no_content' });
  });
});

describe('spec 03 §8.1 step 6 the 10 MiB text + HTML cap', () => {
  const full = extractFromHtml(fixtureHtml('article.html'), 'https://news.example.com/a');
  const textBytes = bytes(full.bodyText);

  it('keeps the whole text and cuts the HTML well-formed when only the HTML overflows', () => {
    const maxOutputBytes = textBytes + 700;
    const result = extractFromHtml(fixtureHtml('article.html'), 'https://news.example.com/a', {
      maxOutputBytes,
    });
    expect(result).toMatchObject({
      status: 'ok',
      completeness: 'partial',
      completenessReason: 'truncated',
      bodyText: full.bodyText,
      bodyLead: full.bodyLead,
      wordCount: 600,
    });
    expect(bytes(result.bodyText) + bytes(result.bodyHtml)).toBeLessThanOrEqual(maxOutputBytes);
    expect(full.bodyHtml?.startsWith((result.bodyHtml ?? '').slice(0, 100))).toBe(true);
    expect(bytes(result.bodyHtml)).toBeGreaterThan(0);
    expectWellFormed(result.bodyHtml ?? '');
  });

  it('cuts the text on a word boundary and drops the HTML when the text alone overflows', () => {
    const result = extractFromHtml(fixtureHtml('article.html'), 'https://news.example.com/a', {
      maxOutputBytes: 2001,
    });
    expect(result).toMatchObject({
      status: 'ok',
      bodyHtml: null,
      completeness: 'partial',
      completenessReason: 'truncated',
    });
    const text = result.bodyText ?? '';
    expect(bytes(text)).toBeLessThanOrEqual(2001);
    expect(bytes(text)).toBeGreaterThan(1000);
    expect(full.bodyText?.startsWith(text)).toBe(true);
    expect(full.bodyText?.charAt(text.length)).toMatch(/\s/);
    expect(result.wordCount).toBe(text.split(/\s+/).length);
  });

  it('never splits a character when cutting multi-byte text', () => {
    const emoji = Array.from({ length: 6 }, () => `<p>${'😀 ľšč '.repeat(80)}</p>`).join('');
    const html = `<html><head><title>e</title></head><body><article>${emoji}</article></body></html>`;
    for (const maxOutputBytes of [997, 998, 999, 1000, 1001, 3333]) {
      const result = extractFromHtml(html, PAGE_URL, { maxOutputBytes });
      expect(result.completenessReason).toBe('truncated');
      const text = result.bodyText ?? '';
      expect(bytes(text) + bytes(result.bodyHtml)).toBeLessThanOrEqual(maxOutputBytes);
      expect(LONE_SURROGATE.test(text)).toBe(false);
      expect(text).not.toContain('�');
    }
    const unspaced = `<html><body><article><p>${'😀'.repeat(1200)}</p></article></body></html>`;
    const result = extractFromHtml(unspaced, PAGE_URL, { maxOutputBytes: 4097 });
    expect(bytes(result.bodyText)).toBe(4096);
    expect(LONE_SURROGATE.test(result.bodyText ?? '')).toBe(false);
  });
});

describe('extractFromHtml robustness', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves relative links against <base href>, ignoring a non-http base', () => {
    const after =
      '<p>Details are in <a href="report/2026">the full report</a> published today.</p>';
    const withBase = extractFromHtml(
      articlePage({ head: '<base href="/archive/">', after }),
      'https://news.example.com/2026/09/26/lead-pipes',
    );
    expect(withBase.bodyHtml).toContain('href="https://news.example.com/archive/report/2026"');
    const scriptBase = extractFromHtml(
      articlePage({ head: '<base target="_top"><base href="javascript:alert(1)">', after }),
      'https://news.example.com/2026/09/26/lead-pipes',
    );
    expect(scriptBase.bodyHtml).toContain('href="https://news.example.com/2026/09/26/report/2026"');
  });

  it('extracts markup without <html>/<body> (bookmark capture of fragments)', () => {
    const fragment = PARAGRAPHS.map((text) => `<p>${text}</p>`).join('');
    expect(extractFromHtml(fragment, PAGE_URL)).toMatchObject({
      status: 'ok',
      completeness: 'complete',
    });
    const headOnly = `<!doctype html><html lang="sk"><head><title>x</title></head>${fragment}</html>`;
    expect(extractFromHtml(headOnly, PAGE_URL)).toMatchObject({ status: 'ok' });
  });

  it('never throws: a Readability failure is extraction_failed', () => {
    vi.spyOn(Readability.prototype, 'parse').mockImplementation(() => {
      throw new Error('boom');
    });
    expect(extractFromHtml(articlePage(), PAGE_URL)).toEqual({
      status: 'failed',
      bodyText: null,
      bodyHtml: null,
      bodyLead: null,
      wordCount: null,
      completeness: 'partial',
      completenessReason: 'extraction_failed',
      canonicalUrl: null,
      error: 'extraction_failed',
      videoEvidence: false,
      bodyImageCount: null,
    });
  });
});
