import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';

import { clip, esc, safeExternalUrl } from '../src/rating-server/html.js';
import { feedsPage, ratePage } from '../src/rating-server/pages.js';
import { redactUrl } from '../src/rating-server/server.js';
import { APP_JS } from '../src/rating-server/static-assets.js';

/**
 * M3a-T3 (spec 10 §2.2, §2.4): keyboard handling of the static script, log redaction and HTML
 * safety of the rating page (unit level; the server is covered by rating-server.int.test.ts).
 */

function ratingDocument() {
  const html = ratePage({
    article: {
      feedTitle: 'Feed',
      title: 'Title',
      excerpt: 'Excerpt',
      url: 'https://example.test/a',
      date: '2026-09-30',
    },
    assignment: {
      articleId: '5',
      position: 1,
      status: 'pending',
      rating: null,
      reason: null,
      skipReason: null,
    },
    progress: { total: 3, pending: 3, rated: 0, skipped: 0, likes: 0, dislikes: 0 },
    lastPosition: 2,
    csrf: 'csrf',
    askReason: false,
  });
  const { document, window } = parseHTML(html);
  const assign = vi.fn();
  const open = vi.fn();
  const fakeWindow = { location: { assign }, open };
  new Function('document', 'window', APP_JS)(document, fakeWindow);
  const press = (
    key: string,
    target: { dispatchEvent: (e: Event) => boolean } = document,
    extra = {},
  ) => {
    const event = new window.Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'key', { value: key });
    for (const [name, value] of Object.entries(extra)) {
      Object.defineProperty(event, name, { value });
    }
    target.dispatchEvent(event);
    return event;
  };
  const clicks = new Map<string, number>();
  for (const button of document.querySelectorAll('button')) {
    const label = `${button.getAttribute('name') ?? ''}=${button.getAttribute('value') ?? button.textContent?.trim()}`;
    button.click = () => {
      clicks.set(label, (clicks.get(label) ?? 0) + 1);
    };
  }
  return { document, press, clicks, assign, open };
}

describe('keyboard handlers (static/app.js)', () => {
  it('+ and = like, - dislikes, 1–6 pick a reason, s skips', () => {
    const { press, clicks } = ratingDocument();
    press('+');
    press('=');
    press('-');
    press('1');
    press('6');
    press('s');
    expect(clicks.get('rating=like')).toBe(2);
    expect(clicks.get('rating=dislike')).toBe(1);
    expect(clicks.get('reason=off_topic')).toBe(1);
    expect(clicks.get('reason=other')).toBe(1);
    expect([...clicks.keys()].some((k) => k.includes('Skip'))).toBe(true);
  });

  it('j/k and the arrows move between articles, o opens the original in a new tab', () => {
    const { press, assign, open } = ratingDocument();
    press('j');
    press('ArrowLeft');
    press('k');
    press('ArrowRight');
    expect(assign.mock.calls.map((c) => c[0])).toEqual(['/r/a/2', '/r/a/0', '/r/a/0', '/r/a/2']);
    press('o');
    expect(open).toHaveBeenCalledWith('https://example.test/a', '_blank', 'noopener,noreferrer');
  });

  it('ignores keys inside form fields and with modifiers', () => {
    const { document, press, clicks } = ratingDocument();
    const input = document.createElement('textarea');
    document.body.appendChild(input);
    press('+', input);
    press('+', document, { ctrlKey: true });
    press('x');
    expect(clicks.size).toBe(0);
  });
});

describe('html helpers', () => {
  it('escapes interpolated text and drops non-http links', () => {
    expect(esc(`<script>"x" & 'y'</script>`)).toBe(
      '&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;',
    );
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('https://example.test/a?b=1')).toBe('https://example.test/a?b=1');
    expect(safeExternalUrl('not a url')).toBeNull();
  });

  it('links each feed and its site in a new tab, outside the checkbox label', () => {
    const feed = (feedId: string, url: string, siteUrl: string | null) =>
      ({ feedId, title: `Feed ${feedId}`, url, siteUrl, langHint: 'sk' }) as const;
    const { document } = parseHTML(
      feedsPage({
        feeds: [
          feed('1', 'https://a.example.test/rss', 'https://a.example.test/'),
          feed('2', 'https://b.example.test/feed.xml', null),
          feed('3', 'https://c.example.test/rss', 'javascript:alert(1)'),
        ],
        selected: new Set(),
        state: { interestCards: 5, neverCards: 0, feeds: 0, assignments: 0 },
        locked: false,
        csrf: 'csrf',
      }),
    );
    const links = [...document.querySelectorAll('.feeds a')];
    expect(links.map((a) => [a.getAttribute('href'), a.textContent])).toEqual([
      ['https://a.example.test/', 'https://a.example.test/ ↗'],
      ['https://a.example.test/rss', 'feed ↗'],
      ['https://b.example.test/feed.xml', 'https://b.example.test/feed.xml ↗'],
      ['https://c.example.test/rss', 'https://c.example.test/rss ↗'],
    ]);
    for (const a of links) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
      expect(a.closest('label')).toBeNull();
    }
  });

  it('cuts excerpts to the limit', () => {
    const text = 'word '.repeat(300);
    const cut = clip(text, 600);
    expect([...cut].length).toBeLessThanOrEqual(600);
    expect(cut.endsWith('…')).toBe(true);
    expect(clip('short', 600)).toBe('short');
  });

  it('a hostile title cannot inject markup into the rating page', () => {
    const html = ratePage({
      article: {
        feedTitle: '<b>feed</b>',
        title: '<img src=x onerror=alert(1)>',
        excerpt: null,
        url: null,
        date: null,
      },
      assignment: {
        articleId: '5',
        position: 0,
        status: 'pending',
        rating: null,
        reason: null,
        skipReason: null,
      },
      progress: { total: 1, pending: 1, rated: 0, skipped: 0, likes: 0, dislikes: 0 },
      lastPosition: 0,
      csrf: 'c',
      askReason: false,
    });
    const { document } = parseHTML(html);
    expect(document.querySelectorAll('img')).toHaveLength(0);
    expect(document.querySelector('h1')?.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('log redaction', () => {
  it('replaces the link token in logged URLs', () => {
    expect(redactUrl('/r?t=SECRET')).toBe('/r?t=[redacted]');
    expect(redactUrl('/facets?x=1&t=SECRET#a')).toBe('/facets?x=1&t=[redacted]#a');
    expect(redactUrl('/r/a/3')).toBe('/r/a/3');
  });
});
