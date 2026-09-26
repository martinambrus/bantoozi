import { describe, expect, it } from 'vitest';

import { detectCanonicalUrl } from '../../src/extract/canonical-link.js';
import { parseDocument } from '../../src/extract/dom.js';

/** A page whose `<head>` declares the given canonical `href`s. */
function page(hrefs: string[], extraHead = ''): string {
  const links = hrefs.map((href) => `<link rel="canonical" href="${href}">`).join('');
  return `<!doctype html><html><head><title>t</title>${extraHead}${links}</head><body><p>x</p></body></html>`;
}

const canonicalOf = (html: string, pageUrl: string, baseUrl?: string): string | null =>
  detectCanonicalUrl(parseDocument(html), pageUrl, baseUrl);

describe('spec 03 §8.1 step 5 rel=canonical', () => {
  it('accepts a canonical on the same host, resolved and canonicalized', () => {
    expect(
      canonicalOf(
        page(['/2026/09/story?utm_source=rss#top']),
        'https://news.example.com/2026/09/story?utm_medium=feed',
      ),
    ).toBe('https://news.example.com/2026/09/story');
    expect(canonicalOf(page(['https://news.example.com/b']), 'https://news.example.com/a')).toBe(
      'https://news.example.com/b',
    );
  });

  it('accepts subdomains and scheme changes within the registrable domain', () => {
    expect(
      canonicalOf(
        page(['https://www.example.com/science/comet']),
        'https://amp.example.com/science/comet',
      ),
    ).toBe('https://www.example.com/science/comet');
    expect(
      canonicalOf(page(['https://example.co.uk/story']), 'http://news.example.co.uk/story'),
    ).toBe('https://example.co.uk/story');
  });

  it('uses the private suffix list: github.io users are different sites', () => {
    expect(
      canonicalOf(
        page(['https://alice.github.io/posts/comet']),
        'https://alice.github.io/blog/comet?amp=1',
      ),
    ).toBe('https://alice.github.io/posts/comet');
    expect(
      canonicalOf(
        page(['https://www.alice.github.io/posts/comet']),
        'https://alice.github.io/amp/comet',
      ),
    ).toBe('https://www.alice.github.io/posts/comet');
    expect(
      canonicalOf(
        page(['https://bob.github.io/posts/comet']),
        'https://alice.github.io/posts/comet',
      ),
    ).toBeNull();
    expect(
      canonicalOf(page(['https://github.io/posts/comet']), 'https://alice.github.io/posts/comet'),
    ).toBeNull();
  });

  it('rejects a canonical on another registrable domain', () => {
    expect(
      canonicalOf(page(['https://www.example.org/story']), 'https://news.example.com/story'),
    ).toBeNull();
    expect(
      canonicalOf(
        page(['https://www-example-com.cdn.ampproject.org/c/s/www.example.com/story']),
        'https://www.example.com/story/amp',
      ),
    ).toBeNull();
  });

  it('requires exact host (and port) equality without a registrable domain', () => {
    expect(canonicalOf(page(['/b']), 'http://127.0.0.1:8080/a')).toBe('http://127.0.0.1:8080/b');
    expect(canonicalOf(page(['http://127.0.0.1:9090/b']), 'http://127.0.0.1:8080/a')).toBeNull();
    expect(canonicalOf(page(['http://localhost/b']), 'http://localhost/a')).toBe(
      'http://localhost/b',
    );
    expect(canonicalOf(page(['http://example.com/b']), 'http://localhost/a')).toBeNull();
    expect(canonicalOf(page(['http://[::1]/b']), 'http://[::1]/a')).toBe('http://[::1]/b');
  });

  it('rejects conflicting canonicals but accepts duplicates of one URL', () => {
    expect(
      canonicalOf(
        page(['https://news.example.com/a', 'https://news.example.com/b']),
        'https://news.example.com/x',
      ),
    ).toBeNull();
    expect(
      canonicalOf(
        page([
          'https://news.example.com/a',
          '/a?utm_campaign=x',
          'https://news.example.com/a#comments',
        ]),
        'https://news.example.com/x',
      ),
    ).toBe('https://news.example.com/a');
  });

  it.each([
    ['the home page', 'https://news.example.com/'],
    ['the home page without a slash', 'https://news.example.com'],
    ['a category page', 'https://news.example.com/category/politics/'],
    ['a nested tag page', 'https://news.example.com/blog/tag/rivers'],
    ['an author page', 'https://news.example.com/author/maya-lindqvist'],
    ['a search page', 'https://news.example.com/search?q=park'],
    ['a paginated list', 'https://news.example.com/politics/page/2'],
    ['a Slovak section page', 'https://news.example.com/rubrika/domov'],
    ['a section ancestor of the page', 'https://news.example.com/politics/'],
    ['a year archive ancestor', 'https://news.example.com/politics/2026'],
  ])('rejects %s as a home/list target', (_name, href) => {
    expect(
      canonicalOf(page([href]), 'https://news.example.com/politics/2026/09/park-vote'),
    ).toBeNull();
  });

  it('accepts an article at the root with a query, and the article of an AMP path', () => {
    expect(canonicalOf(page(['/?p=4821']), 'https://blog.example.com/?p=4821&amp=1')).toBe(
      'https://blog.example.com/?p=4821',
    );
    expect(
      canonicalOf(page(['/2026/09/park-vote/']), 'https://news.example.com/2026/09/park-vote/amp/'),
    ).toBe('https://news.example.com/2026/09/park-vote/');
    expect(
      canonicalOf(
        page(['/2026/09/park-vote']),
        'https://news.example.com/2026/09/park-vote/amp.html',
      ),
    ).toBe('https://news.example.com/2026/09/park-vote');
    expect(canonicalOf(page(['/story/page-two']), 'https://news.example.com/story/page/2')).toBe(
      'https://news.example.com/story/page-two',
    );
  });

  it.each([
    ['an empty href', ''],
    ['a non-http scheme', 'ftp://news.example.com/a'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['credentials', 'https://user:secret@news.example.com/a'],
    ['an unparsable URL', 'http://[oops/a'],
  ])('rejects %s', (_name, href) => {
    expect(canonicalOf(page([href]), 'https://news.example.com/x')).toBeNull();
    expect(
      canonicalOf(page([href, 'https://news.example.com/a']), 'https://news.example.com/x'),
    ).toBeNull();
  });

  it('reads rel tokens case-insensitively, ignores links in <body> and other rels', () => {
    const mixed = `<!doctype html><html><head><link rel="Alternate CANONICAL" href="/a"></head><body></body></html>`;
    expect(canonicalOf(mixed, 'https://news.example.com/x')).toBe('https://news.example.com/a');
    const inBody = `<!doctype html><html><head><link rel="alternate" href="/feed"></head><body><div><link rel="canonical" href="/evil"></div></body></html>`;
    expect(canonicalOf(inBody, 'https://news.example.com/x')).toBeNull();
    expect(canonicalOf(page([]), 'https://news.example.com/x')).toBeNull();
    const noHref = `<!doctype html><html><head><link rel="canonical"></head><body></body></html>`;
    expect(canonicalOf(noHref, 'https://news.example.com/x')).toBeNull();
  });

  it('compares path segments even when they are not valid percent-encodings', () => {
    expect(
      canonicalOf(page(['/politics/%E0%A4%A']), 'https://news.example.com/politics/%E0%A4%A/amp'),
    ).toBe('https://news.example.com/politics/%E0%A4%A');
    expect(
      canonicalOf(page(['/%E0%A4%A/']), 'https://news.example.com/%E0%A4%A/2026/story'),
    ).toBeNull();
  });

  it('resolves against the document base and needs a valid page URL', () => {
    expect(
      canonicalOf(
        page(['story']),
        'https://news.example.com/amp/story',
        'https://news.example.com/2026/',
      ),
    ).toBe('https://news.example.com/2026/story');
    expect(canonicalOf(page(['https://news.example.com/a']), 'not a url')).toBeNull();
  });
});
