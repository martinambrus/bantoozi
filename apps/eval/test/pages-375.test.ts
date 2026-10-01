import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import {
  cardsPage,
  donePage,
  facetPage,
  feedsPage,
  messagePage,
  ratePage,
  startPage,
} from '../src/rating-server/pages.js';
import { APP_CSS } from '../src/rating-server/static-assets.js';

/**
 * M3a-T3 "Pages work at a 375 px width" (spec 10 §2.4: mobile-friendly): every page declares the
 * device-width viewport, uses only the shared stylesheet (no inline style or script), and the CSS
 * is fluid: no fixed or minimum width above 375 px, border-box sizing and a narrow-screen query.
 */

const state = { interestCards: 5, neverCards: 1, feeds: 12, assignments: 0 };
const progress = { total: 300, pending: 290, rated: 8, skipped: 2, likes: 5, dislikes: 3 };
const article = {
  feedTitle: 'Denník N',
  title: 'A very long headline '.repeat(10),
  excerpt: 'Text '.repeat(100),
  url: 'https://example.test/a',
  date: '2026-09-30',
};

const PAGES: Record<string, string> = {
  message: messagePage('Link expired', 'Ask for a new link.'),
  cards: cardsPage({
    raterName: 'Owner',
    langs: ['sk', 'en'],
    cards: [
      {
        cardId: '1',
        title: 'Battery chemistry',
        interest: 'New battery chemistry for electric vehicles',
        notFor: 'Stock prices',
        interestEn: null,
        notForEn: null,
        examplesYes: ['Solid-state pilot line'],
        examplesNo: [],
        lang: 'en',
        strength: 'love',
      },
    ],
    state,
    locked: false,
    csrf: 'csrf',
  }),
  feeds: feedsPage({
    feeds: [
      {
        feedId: '1',
        title: 'Feed with a rather long name that has to wrap on a phone screen',
        url: 'https://feeds.example.test/a-very-long-feed-url-without-any-spaces-at-all.xml',
        siteUrl: null,
        langHint: 'sk',
      },
    ],
    selected: new Set(['1']),
    state,
    locked: false,
    csrf: 'csrf',
  }),
  start: startPage({ state, csrf: 'csrf' }),
  done: donePage({ state, progress, canLoadMore: true, csrf: 'csrf' }),
  rate: ratePage({
    article,
    assignment: {
      articleId: '9',
      position: 3,
      status: 'rated',
      rating: -1,
      reason: 'clickbait',
      skipReason: null,
    },
    progress,
    lastPosition: 299,
    csrf: 'csrf',
    askReason: true,
  }),
  facets: facetPage({
    article,
    articleId: '9',
    index: 0,
    total: 300,
    labelled: 0,
    role: 'primary',
    values: { depth: '2' },
    csrf: 'csrf',
  }),
};

/** Declarations (not media conditions) of `width`/`min-width` with their size in px. */
function fixedWidths(css: string): Array<{ decl: string; px: number }> {
  const out: Array<{ decl: string; px: number }> = [];
  const pattern = /(?<![-\w])(min-width|width)\s*:\s*([\d.]+)(px|rem|em|vw|%)\s*[;}]/gu;
  for (const match of css.matchAll(pattern)) {
    const value = Number(match[2]);
    const unit = match[3];
    if (unit === 'vw' || unit === '%') continue;
    out.push({ decl: match[0], px: unit === 'px' ? value : value * 16 });
  }
  return out;
}

describe('rating pages at 375 px', () => {
  for (const [name, html] of Object.entries(PAGES)) {
    it(`${name}: viewport meta, shared assets only, no fixed widths`, () => {
      const { document } = parseHTML(html);
      const viewport = document.querySelector('meta[name="viewport"]');
      expect(viewport?.getAttribute('content')).toContain('width=device-width');
      expect(viewport?.getAttribute('content')).toContain('initial-scale=1');
      expect(document.querySelector('link[rel="stylesheet"]')?.getAttribute('href')).toBe(
        '/static/app.css',
      );
      const scripts = [...document.querySelectorAll('script')];
      expect(scripts).toHaveLength(1);
      expect(scripts[0]?.getAttribute('src')).toBe('/static/app.js');
      expect(scripts[0]?.textContent?.trim()).toBe('');
      expect(document.querySelectorAll('style')).toHaveLength(0);
      expect(document.querySelectorAll('[style]')).toHaveLength(0);
      for (const element of document.querySelectorAll('[width]')) {
        expect(Number(element.getAttribute('width'))).toBeLessThanOrEqual(375);
      }
      expect(document.querySelector('main.wrap')).not.toBeNull();
    });
  }

  it('the stylesheet is fluid: no width or min-width above 375 px', () => {
    for (const { decl, px } of fixedWidths(APP_CSS)) {
      expect(px, decl).toBeLessThanOrEqual(375);
    }
    expect(APP_CSS).toMatch(/box-sizing:\s*border-box/u);
    expect(APP_CSS).toMatch(/\.wrap\s*\{[^}]*width:\s*100%[^}]*max-width:\s*40rem/u);
    expect(APP_CSS).toMatch(/@media \(max-width: 30rem\)/u);
    expect(APP_CSS).toMatch(/overflow-wrap:\s*anywhere/u);
    expect(APP_CSS).toMatch(/flex-wrap:\s*wrap/u);
    // Form controls never exceed their container.
    expect(APP_CSS).toMatch(/input\[type="text"\], textarea, select \{[^}]*max-width:\s*100%/u);
  });

  it('the width check itself catches a fixed width', () => {
    expect(fixedWidths('.x { width: 480px; } .y { min-width: 30rem }')).toEqual([
      { decl: 'width: 480px;', px: 480 },
      { decl: 'min-width: 30rem }', px: 480 },
    ]);
    expect(fixedWidths('@media (max-width: 30rem) { .a { max-width: 40rem; } }')).toEqual([]);
  });
});
