import { normalizeText } from '@bantoozi/shared';
import { describe, expect, it } from 'vitest';

import type { NormalizedItem, RawFeedItem } from '../../src/parse/index.js';
import { PARSE_LIMITS, computeContentHash, normalizeItem } from '../../src/parse/index.js';
import { NOW } from './helpers.js';

const BASE = 'https://feed.example/articles/';

function raw(overrides: Partial<RawFeedItem> = {}): RawFeedItem {
  return {
    sourceIndex: 3,
    title: { value: 'A title', type: 'html' },
    links: [{ href: 'story', base: BASE }],
    guid: 'guid-1',
    dates: ['2026-09-25T08:00:00Z'],
    authors: [],
    categories: [],
    content: { html: '<p>Body text.</p>', base: BASE },
    images: [],
    media: [],
    ...overrides,
  };
}

function normalized(overrides: Partial<RawFeedItem> = {}): NormalizedItem {
  const result = normalizeItem(raw(overrides), { now: NOW });
  if (!result.ok) throw new Error(`unexpected ${result.code}`);
  return result.item;
}

describe('normalizeItem (spec 03 §6)', () => {
  it('produces a complete NormalizedItem', () => {
    const item = normalized({ authors: ['Ana'], categories: ['News'] });
    expect(item).toEqual({
      sourceIndex: 3,
      title: 'A title',
      titleNorm: 'a title',
      link: 'https://feed.example/articles/story',
      guid: 'guid-1',
      publishedAt: new Date('2026-09-25T08:00:00Z'),
      author: 'Ana',
      categories: ['News'],
      excerptHtml: '<p>Body text.</p>',
      excerpt: 'Body text.',
      feedBodyText: 'Body text.',
      feedBodyHtml: '<p>Body text.</p>',
      feedBodyTruncated: false,
      imageUrl: null,
      videoEvidence: false,
      feedBodyImageCount: 0,
      contentHash: computeContentHash({
        title: 'A title',
        excerpt: 'Body text.',
        author: 'Ana',
        categories: ['News'],
        link: 'https://feed.example/articles/story',
        feedBodyText: 'Body text.',
      }),
    });
  });

  describe('title', () => {
    it('strips HTML, decodes entities and collapses whitespace', () => {
      expect(
        normalized({ title: { value: '  <b>Big</b>\n news &amp; <i>more</i>  ', type: 'html' } })
          .title,
      ).toBe('Big news & more');
      expect(
        normalized({ title: { value: 'Tom &amp;amp; Jerry &eacute;', type: 'html' } }).title,
      ).toBe('Tom &amp; Jerry é');
    });

    it('keeps markup-like text that is not a known inline tag, and literal text titles', () => {
      expect(
        normalized({ title: { value: 'Using the <details> element', type: 'html' } }).title,
      ).toBe('Using the <details> element');
      expect(
        normalized({
          title: { value: 'Using <code>fetch()</code> in <x-y>Node</x-y>', type: 'html' },
        }).title,
      ).toBe('Using fetch() in Node');
      expect(
        normalized({ title: { value: 'A <dfn>term</dfn> defined', type: 'html' } }).title,
      ).toBe('A term defined');
      expect(normalized({ title: { value: '5 < 7 &amp; x', type: 'text' } }).title).toBe(
        '5 < 7 &amp; x',
      );
    });

    it('is case-preserving; title_norm folds case and diacritics', () => {
      const item = normalized({ title: { value: 'Ľudia v Košiciach — MHD', type: 'html' } });
      expect(item.title).toBe('Ľudia v Košiciach — MHD');
      expect(item.titleNorm).toBe(normalizeText('Ľudia v Košiciach — MHD'));
      expect(item.titleNorm).toBe('ludia v kosiciach mhd');
    });

    it('falls back to the first 80 chars of the excerpt, else "(untitled)"', () => {
      const long = 'Word '.repeat(40);
      expect(
        normalized({
          title: { value: ' <b> </b> ', type: 'html' },
          content: { html: long, base: BASE },
        }).title,
      ).toBe(long.slice(0, 80).trim());
      expect(normalized({ title: null, content: { html: '<p>Short</p>', base: BASE } }).title).toBe(
        'Short',
      );
      const untitled = normalized({ title: null, content: null });
      expect(untitled.title).toBe('(untitled)');
      expect(untitled.titleNorm).toBe('untitled');
    });

    it('is at most 500 chars', () => {
      const item = normalized({ title: { value: 'é'.repeat(600), type: 'text' } });
      expect(item.title).toBe('é'.repeat(500));
      expect(normalized({ title: { value: '😀'.repeat(501), type: 'text' } }).title).toBe(
        '😀'.repeat(500),
      );
      // 300 emoji are 600 UTF-16 units but only 300 chars.
      expect(normalized({ title: { value: '😀'.repeat(300), type: 'text' } }).title).toBe(
        '😀'.repeat(300),
      );
    });
  });

  describe('guid', () => {
    it('is opaque and case-sensitive; surrounding XML whitespace and control characters go', () => {
      expect(normalized({ guid: '\n  AbC/def?x=1&Y=2  \t' }).guid).toBe('AbC/def?x=1&Y=2');
      expect(normalized({ guid: 'a\u0000b' }).guid).toBe('ab');
    });

    it('treats an empty or whitespace-only identifier as missing', () => {
      expect(normalized({ guid: '' }).guid).toBeNull();
      expect(normalized({ guid: ' \n ' }).guid).toBeNull();
    });

    it('keeps a 4,096-char GUID complete and rejects a longer one', () => {
      const limit = `urn:${'Xy'.repeat(2046)}`;
      expect(limit).toHaveLength(PARSE_LIMITS.guidChars);
      expect(normalized({ guid: limit }).guid).toBe(limit);
      expect(normalizeItem(raw({ guid: `${limit}z` }), { now: NOW })).toEqual({
        ok: false,
        code: 'ITEM_GUID_TOO_LONG',
      });
      // Characters, not UTF-16 units, are counted.
      expect(normalized({ guid: '😀'.repeat(4096) }).guid).toHaveLength(8192);
    });
  });

  describe('link', () => {
    it('takes the first candidate that resolves to http(s)', () => {
      expect(
        normalized({
          links: [
            { href: 'javascript:void(0)', base: BASE },
            { href: 'mailto:a@b.example', base: BASE },
            { href: '  ', base: BASE },
            { href: '../other?a=1', base: BASE },
          ],
        }).link,
      ).toBe('https://feed.example/other?a=1');
    });

    it('requires candidates without a base to be absolute already', () => {
      expect(normalized({ links: [{ href: 'incident/772' }] }).link).toBeNull();
      expect(normalized({ links: [{ href: 'https://x.example/p' }] }).link).toBe(
        'https://x.example/p',
      );
      expect(normalized({ links: [{ href: 'ftp://x.example/p' }] }).link).toBeNull();
    });

    it('rejects links longer than 8,192 chars', () => {
      const href = `https://x.example/${'a'.repeat(PARSE_LIMITS.urlChars)}`;
      expect(normalized({ links: [{ href }] }).link).toBeNull();
    });
  });

  describe('published_at', () => {
    it('uses the first valid candidate in order', () => {
      expect(
        normalized({
          dates: ['', 'not a date', 'Fri, 25 Sep 2026 10:00:00 GMT', '2026-01-01'],
        }).publishedAt?.toISOString(),
      ).toBe('2026-09-25T10:00:00.000Z');
    });

    it('treats a date more than one day ahead as unknown', () => {
      const dayAhead = new Date(NOW.getTime() + PARSE_LIMITS.futureToleranceMs);
      expect(normalized({ dates: [dayAhead.toISOString()] }).publishedAt).toEqual(dayAhead);
      const beyond = new Date(dayAhead.getTime() + 1_000);
      expect(normalized({ dates: [beyond.toISOString(), '2026-09-01'] }).publishedAt).toBeNull();
    });

    it('is null when there is no valid date', () => {
      expect(normalized({ dates: [] }).publishedAt).toBeNull();
      expect(normalized({ dates: ['soon'] }).publishedAt).toBeNull();
    });
  });

  describe('author', () => {
    it('takes the first non-empty candidate as text, at most 200 chars', () => {
      expect(normalized({ authors: ['', '  ', ' Jana\n Nováková ', 'Other'] }).author).toBe(
        'Jana Nováková',
      );
      expect(normalized({ authors: ['John &amp; Jane'] }).author).toBe('John & Jane');
      expect(normalized({ authors: ['a'.repeat(250)] }).author).toBe('a'.repeat(200));
      expect(normalized({ authors: [] }).author).toBeNull();
    });
  });

  describe('categories', () => {
    it('trims, decodes, deduplicates case-insensitively and keeps the first spelling', () => {
      expect(
        normalized({
          categories: [
            ' News ',
            'news',
            'NEWS',
            '',
            '  ',
            'Politics &amp; Society',
            'Café',
            'CAFÉ',
          ],
        }).categories,
      ).toEqual(['News', 'Politics & Society', 'Café']);
    });

    it('keeps at most 16 categories of at most 64 chars', () => {
      const many = Array.from({ length: 20 }, (_, i) => `Category ${i}`);
      expect(normalized({ categories: many }).categories).toEqual(many.slice(0, 16));
      expect(normalized({ categories: ['x'.repeat(100)] }).categories).toEqual(['x'.repeat(64)]);
      // Truncation can create duplicates; they are removed too.
      expect(
        normalized({ categories: [`${'y'.repeat(64)}a`, `${'y'.repeat(64)}b`] }).categories,
      ).toEqual(['y'.repeat(64)]);
    });
  });

  describe('content', () => {
    it('keeps the full body and truncates the excerpt HTML (10,000) and text (2,000)', () => {
      const paragraphs = Array.from(
        { length: 400 },
        (_, i) => `<p>Paragraph number ${i} text.</p>`,
      );
      const item = normalized({ content: { html: paragraphs.join(''), base: BASE } });
      expect(item.feedBodyHtml).toBe(paragraphs.join(''));
      expect(item.feedBodyText?.split('\n\n')).toHaveLength(400);
      expect(item.feedBodyTruncated).toBe(false);
      expect(item.excerptHtml?.length).toBeLessThanOrEqual(PARSE_LIMITS.excerptHtmlChars);
      expect(item.excerptHtml?.endsWith('</p>')).toBe(true);
      expect(item.excerpt?.length).toBe(PARSE_LIMITS.excerptChars);
      expect(item.excerpt?.startsWith('Paragraph number 0 text. Paragraph number 1 text.')).toBe(
        true,
      );
    });

    it('bounds the source HTML before sanitizing and marks the body truncated', () => {
      const html = `<p><img src="/before.jpg">${'a'.repeat(PARSE_LIMITS.contentInputChars)}</p><p><img src="/after.jpg">tail</p><video></video>`;
      const item = normalized({ content: { html, base: BASE } });
      expect(item.feedBodyTruncated).toBe(true);
      expect(item.feedBodyText).not.toContain('tail');
      // Media signals read the same bounded input the body is built from.
      expect(item.feedBodyImageCount).toBe(1);
      expect(item.videoEvidence).toBe(false);
    });

    it('keeps text + HTML within the 10 MiB body limit', () => {
      // Escaping multiplies "&" by five in the HTML: about 10.8 MiB of text + HTML.
      const html = `<p>${'&'.repeat(1.8 * 1024 * 1024)}</p>`;
      const item = normalized({ content: { html, base: BASE } });
      const bytes =
        Buffer.byteLength(item.feedBodyHtml ?? '') + Buffer.byteLength(item.feedBodyText ?? '');
      expect(bytes).toBeLessThanOrEqual(PARSE_LIMITS.bodyBytes);
      expect(item.feedBodyTruncated).toBe(true);
      expect(item.feedBodyHtml?.endsWith('</p>')).toBe(true);
    }, 30_000);

    it('counts only the images of the stored text when the limit cuts the body', () => {
      // Each paragraph escapes to 2 MiB of HTML: the body keeps the first two and part of the third.
      const paragraph = (n: number) =>
        `<p><img src="/p${n}.jpg">${'&'.repeat(0.4 * 1024 * 1024)}</p>`;
      const html = [1, 2, 3, 4, 5].map(paragraph).join('');
      const item = normalized({ content: { html, base: BASE } });
      expect(item.feedBodyTruncated).toBe(true);
      const paragraphs = item.feedBodyText?.split('\n\n') ?? [];
      expect(paragraphs).toHaveLength(3);
      expect(paragraphs[2]!.length).toBeLessThan(0.4 * 1024 * 1024);
      // The photos of the fourth and fifth paragraphs lie after the cut.
      expect(item.feedBodyImageCount).toBe(3);
    }, 30_000);

    it('has no body or excerpt when the content has no text', () => {
      const item = normalized({ content: { html: '<p><img src="/only.jpg"></p>', base: BASE } });
      expect(item).toMatchObject({
        excerptHtml: null,
        excerpt: null,
        feedBodyHtml: null,
        feedBodyText: null,
        feedBodyImageCount: null,
        imageUrl: 'https://feed.example/only.jpg',
      });
    });
  });

  describe('image', () => {
    it('prefers the metadata candidates over the first content image', () => {
      const content = { html: '<p><img src="inline.jpg">x</p>', base: BASE };
      expect(
        normalized({
          content,
          images: [
            { href: 'javascript:x', base: BASE },
            { href: 'meta.jpg', base: BASE },
          ],
        }).imageUrl,
      ).toBe('https://feed.example/articles/meta.jpg');
      expect(normalized({ content }).imageUrl).toBe('https://feed.example/articles/inline.jpg');
    });
  });

  describe('media signals (spec 03 §6.4)', () => {
    it('video evidence from a video media object, never from audio', () => {
      expect(normalized({ media: [{ type: 'video/mp4', medium: null }] }).videoEvidence).toBe(true);
      expect(normalized({ media: [{ type: null, medium: 'video' }] }).videoEvidence).toBe(true);
      expect(normalized({ media: [{ type: 'audio/mpeg', medium: null }] }).videoEvidence).toBe(
        false,
      );
    });

    it('video evidence from the selected link on a video host', () => {
      expect(
        normalized({ links: [{ href: 'https://www.youtube.com/watch?v=tr4mR3st0r3' }] })
          .videoEvidence,
      ).toBe(true);
      // Only the selected link counts, not a later link candidate.
      expect(
        normalized({
          links: [{ href: 'story', base: BASE }, { href: 'https://www.youtube.com/watch?v=x' }],
        }).videoEvidence,
      ).toBe(false);
    });

    it('video evidence from the content HTML read before sanitizing', () => {
      const html =
        '<p>Watch the restoration.</p><iframe src="https://www.youtube-nocookie.com/embed/tr4mR3st0r3"></iframe>';
      const item = normalized({ content: { html, base: BASE } });
      expect(item.videoEvidence).toBe(true);
      expect(item.feedBodyHtml).toBe('<p>Watch the restoration.</p>');
      // A content with an embed only still has video evidence, but no body to count images in.
      const embedOnly = normalized({
        content: { html: '<video src="clip.mp4" poster="poster.jpg"></video>', base: BASE },
      });
      expect(embedOnly).toMatchObject({
        videoEvidence: true,
        feedBodyHtml: null,
        feedBodyImageCount: null,
      });
    });

    it('counts in-body images before sanitizing removes them, resolving against the content base', () => {
      const html = [
        '<p>Seed library opens.</p>',
        '<img src="/a.jpg" width="1024" height="683">',
        '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="b.jpg"><noscript><img src="https://feed.example/articles/b.jpg"></noscript>',
        '<img src="https://stats.example.net/p.gif" width="1" height="1">',
      ].join('');
      const item = normalized({ content: { html, base: BASE } });
      expect(item.feedBodyHtml).toBe('<p>Seed library opens.</p>');
      expect(item.feedBodyImageCount).toBe(2);
    });

    it('keeps content_hash independent of media', () => {
      const plain = normalized();
      const withVideo = normalized({ media: [{ type: 'video/mp4' }] });
      expect(withVideo.videoEvidence).toBe(true);
      expect(withVideo.contentHash).toBe(plain.contentHash);
      const withImages = normalized({
        content: { html: '<p>Body text.</p><img src="/a.jpg"><video></video>', base: BASE },
      });
      expect(withImages).toMatchObject({ videoEvidence: true, feedBodyImageCount: 1 });
      expect(withImages.contentHash).toBe(plain.contentHash);
    });

    it('has no video evidence and no count without content or media', () => {
      expect(normalized({ content: null, media: [] })).toMatchObject({
        videoEvidence: false,
        feedBodyImageCount: null,
      });
    });
  });

  it('rejects an item with no title, link, identifier or content', () => {
    const empty = raw({ title: null, links: [], guid: null, content: null });
    expect(normalizeItem(empty, { now: NOW })).toEqual({ ok: false, code: 'ITEM_EMPTY' });
    // Only markup, an unusable link and an image: nothing identifies or describes it.
    const markupOnly = raw({
      title: { value: '<b></b>', type: 'html' },
      links: [{ href: 'javascript:void(0)', base: BASE }],
      guid: null,
      content: { html: '<img src="x.jpg">', base: BASE },
    });
    expect(normalizeItem(markupOnly, { now: NOW })).toEqual({ ok: false, code: 'ITEM_EMPTY' });
  });
});
