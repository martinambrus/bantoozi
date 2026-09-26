import { describe, expect, it } from 'vitest';

import { MAX_REPORTED_ITEM_ERRORS, PARSE_LIMITS, parseFeed } from '../../src/parse/index.js';
import { NOW, rss } from './helpers.js';

const URL = 'https://feed.example/rss';

function items(count: number, make: (i: number) => string): string {
  return Array.from({ length: count }, (_, i) => make(i)).join('');
}

/** An RSS item dated `i` minutes before 2026-09-26T00:00Z (so higher `i` is older). */
function datedItem(i: number): string {
  const date = new Date(Date.UTC(2026, 8, 26) - i * 60_000).toUTCString();
  return `<item><title>Item ${i}</title><link>https://feed.example/${i}</link><pubDate>${date}</pubDate></item>`;
}

describe('parseFeed limits and ordering (spec 03 §6)', () => {
  it('keeps at most 200 valid items, newest first, and reports the truncation', async () => {
    // Publisher order is oldest first; dates decide the order.
    const text = rss(items(250, (i) => datedItem(249 - i)));
    const result = await parseFeed(text, { url: URL, now: NOW });
    if (!result.ok) throw new Error(result.message);
    expect(result.totalItems).toBe(250);
    expect(result.items).toHaveLength(PARSE_LIMITS.maxItems);
    expect(result.itemsTruncated).toBe(true);
    expect(result.items[0]?.title).toBe('Item 0');
    expect(result.items[199]?.title).toBe('Item 199');
    const times = result.items.map((item) => item.publishedAt?.getTime() ?? 0);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('honours a smaller maxItems and does not truncate when everything fits', async () => {
    const text = rss(items(5, datedItem));
    const three = await parseFeed(text, { url: URL, now: NOW, maxItems: 3 });
    expect(three).toMatchObject({ ok: true, itemsTruncated: true, totalItems: 5 });
    const all = await parseFeed(text, { url: URL, now: NOW, maxItems: 5 });
    expect(all).toMatchObject({ ok: true, itemsTruncated: false });
  });

  it('counts only valid items against the cap and skips invalid ones', async () => {
    const text = rss(
      `<item><guid>${'g'.repeat(5000)}</guid><title>too long</title></item><item></item>${items(3, datedItem)}`,
    );
    const result = await parseFeed(text, { url: URL, now: NOW, maxItems: 3 });
    expect(result).toMatchObject({
      ok: true,
      totalItems: 5,
      itemsTruncated: false,
      itemErrors: [
        { index: 0, code: 'ITEM_GUID_TOO_LONG' },
        { index: 1, code: 'ITEM_EMPTY' },
      ],
      itemErrorCount: 2,
    });
  });

  it('bounds the reported item errors but counts them all', async () => {
    const text = rss(`${items(150, () => '<item></item>')}${datedItem(1)}`);
    const result = await parseFeed(text, { url: URL, now: NOW });
    if (!result.ok) throw new Error(result.message);
    expect(result.itemErrors).toHaveLength(MAX_REPORTED_ITEM_ERRORS);
    expect(result.itemErrorCount).toBe(150);
    expect(result.items).toHaveLength(1);
  });

  it('keeps publisher order for undated items after dated ones', async () => {
    const text = rss(
      '<item><title>u1</title></item><item><title>d-old</title><pubDate>2026-09-01T00:00:00Z</pubDate></item>' +
        '<item><title>u2</title></item><item><title>d-new</title><pubDate>2026-09-20T00:00:00Z</pubDate></item>' +
        '<item><title>d-tie</title><pubDate>2026-09-20T00:00:00Z</pubDate></item><item><title>u3</title></item>',
    );
    const result = await parseFeed(text, { url: URL, now: NOW });
    if (!result.ok) throw new Error(result.message);
    expect(result.items.map((item) => item.title)).toEqual([
      'd-new',
      'd-tie',
      'd-old',
      'u1',
      'u2',
      'u3',
    ]);
  });

  it('rejects documents with more than 10,000 source items (a generated > 10,000-item feed)', async () => {
    const text = rss(
      items(PARSE_LIMITS.maxSourceItems + 1, (i) => `<item><title>${i}</title></item>`),
    );
    expect(await parseFeed(text, { url: URL, now: NOW })).toEqual({
      ok: false,
      code: 'FEED_PARSE_ERROR',
      message: 'The feed has more than 10000 items',
    });
  }, 30_000);

  it('rejects nesting deeper than 64 levels before parsing', async () => {
    const deep = `${'<x>'.repeat(70)}deep${'</x>'.repeat(70)}`;
    expect(
      await parseFeed(rss(`<item><title>t</title>${deep}</item>`), { url: URL, now: NOW }),
    ).toEqual({
      ok: false,
      code: 'FEED_PARSE_ERROR',
      message: 'XML nesting exceeds 64 levels',
    });
  });

  it('terminates the parser worker when it overruns the deadline', async () => {
    const text = rss(
      items(
        9000,
        (i) =>
          `<item><title>Item ${i}</title><description>${'lorem ipsum '.repeat(10)}</description></item>`,
      ),
    );
    const result = await parseFeed(text, { url: URL, now: NOW, deadlineMs: 1 });
    expect(result).toEqual({
      ok: false,
      code: 'FEED_PARSE_ERROR',
      message: 'XML parsing exceeded the 1 ms deadline',
    });
  }, 30_000);

  it('parses a large (> 5 MB) feed within the parser thread heap limit', async () => {
    const body = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(9);
    const text = rss(
      items(
        9500,
        (i) =>
          `<item><title>Item ${i}</title><link>https://feed.example/${i}</link><guid>id-${i}</guid><description>${body}</description></item>`,
      ),
    );
    expect(text.length).toBeGreaterThan(5 * 1024 * 1024);
    // A generous deadline keeps this test about memory, not about the speed of a loaded CI host.
    const result = await parseFeed(text, { url: URL, now: NOW, deadlineMs: 20_000 });
    expect(result).toMatchObject({ ok: true, totalItems: 9500, itemsTruncated: true });
    if (result.ok) expect(result.items).toHaveLength(200);
  }, 60_000);
});

describe('parseFeed documents and errors', () => {
  it('recovers malformed XML once with the lenient pass', async () => {
    const result = await parseFeed(rss('<item><title>Fish & Chips</title></item>'), {
      url: URL,
      now: NOW,
    });
    expect(result).toMatchObject({ ok: true, lenient: true, items: [{ title: 'Fish & Chips' }] });
  });

  it('fails when the lenient pass cannot repair the document', async () => {
    const result = await parseFeed(
      '<rss version="2.0"><channel><title>a < b</title></channel></rss>',
      {
        url: URL,
        now: NOW,
      },
    );
    expect(result).toMatchObject({ ok: false, code: 'FEED_PARSE_ERROR' });
    if (!result.ok) expect(result.message).toMatch(/^Malformed XML: /);
    // Nothing to repair: the document is not retried.
    const truncated = await parseFeed('<rss version="2.0"><channel><title>cut', {
      url: URL,
      now: NOW,
    });
    expect(truncated).toMatchObject({ ok: false, code: 'FEED_PARSE_ERROR' });
  });

  it('parses RSS without a version, RSS 0.91 and Atom without entries', async () => {
    const plain = await parseFeed(
      '<rss><channel><title>No version</title><item><title>x</title></item></channel></rss>',
      { url: URL, now: NOW },
    );
    expect(plain).toMatchObject({ ok: true, kind: 'rss', totalItems: 1 });
    const old = await parseFeed(
      '<rss version="0.91"><channel><title>Old</title><item><title>y</title><link>/y</link></item></channel></rss>',
      { url: URL, now: NOW },
    );
    expect(old).toMatchObject({ ok: true, items: [{ link: 'https://feed.example/y' }] });
    const atom = await parseFeed(
      '<feed xmlns="http://www.w3.org/2005/Atom"><title>Empty</title></feed>',
      {
        url: URL,
        now: NOW,
      },
    );
    expect(atom).toMatchObject({ ok: true, kind: 'atom', items: [], feed: { title: 'Empty' } });
  });

  it('treats empty channels and unexpected shapes as empty, not as crashes', async () => {
    expect(
      await parseFeed('<rss version="2.0"><channel/></rss>', { url: URL, now: NOW }),
    ).toMatchObject({
      ok: true,
      totalItems: 0,
      feed: { title: null, siteUrl: null },
    });
    expect(
      await parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"/>', { url: URL, now: NOW }),
    ).toMatchObject({ ok: true, totalItems: 0 });
    // Without attributes or children the root is not recognized as a feed at all.
    expect(await parseFeed('<feed/>', { url: URL, now: NOW })).toMatchObject({
      ok: false,
      code: 'FEED_NOT_A_FEED',
    });
    expect(
      await parseFeed(
        '<feed><entry>text only</entry><entry><title>t</title><link>no attributes</link></entry></feed>',
        { url: URL, now: NOW },
      ),
    ).toMatchObject({
      ok: true,
      totalItems: 2,
      itemErrors: [{ index: 0, code: 'ITEM_EMPTY' }],
      items: [{ title: 't', link: null }],
    });
    expect(await parseFeed('<rss version="2.0"></rss>', { url: URL, now: NOW })).toMatchObject({
      ok: false,
      code: 'FEED_PARSE_ERROR',
    });
  });

  it.each([
    ['an HTML page', '<!DOCTYPE html><html><body><p>Hello</p></body></html>', 'text/html'],
    ['unknown XML', '<opml version="2.0"><body/></opml>', 'application/xml'],
    ['plain text', 'Service temporarily unavailable', 'text/plain'],
    ['an empty body', '', undefined],
    ['JSON that is not a JSON Feed', '{"items": []}', 'application/json'],
    ['a JSON array', '[1, 2]', 'application/json'],
    ['broken JSON', '{"title": ', 'application/json'],
  ])('%s is FEED_NOT_A_FEED', async (_label, text, contentType) => {
    expect(await parseFeed(text, { url: URL, contentType, now: NOW })).toMatchObject({
      ok: false,
      code: 'FEED_NOT_A_FEED',
    });
  });

  it('reports a broken JSON Feed as FEED_PARSE_ERROR', async () => {
    expect(
      await parseFeed('{"version": "https://jsonfeed.org/version/1.1", "items": [', {
        url: URL,
        now: NOW,
      }),
    ).toEqual({ ok: false, code: 'FEED_PARSE_ERROR', message: 'Malformed JSON Feed' });
    expect(
      await parseFeed('{"version": "https://jsonfeed.org/version/1.1", "items": {}}', {
        url: URL,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: 'FEED_PARSE_ERROR' });
    const tooMany = JSON.stringify({
      version: 'https://jsonfeed.org/version/1',
      items: Array.from({ length: PARSE_LIMITS.maxSourceItems + 1 }, (_, i) => ({ id: String(i) })),
    });
    expect(await parseFeed(tooMany, { url: URL, now: NOW })).toMatchObject({
      ok: false,
      code: 'FEED_PARSE_ERROR',
    });
  });

  it('parses a JSON Feed with a byte order mark and odd members', async () => {
    const text = `\uFEFF${JSON.stringify({
      version: 'https://jsonfeed.org/version/1.1',
      title: 'Odd',
      authors: [{ name: 'Feed Author' }],
      items: [
        { id: 7, title: ['not a string'], url: 42, content_text: 'Text only', tags: 'nope' },
        { id: null, url: 'https://feed.example/2', summary: 'Summary only', author: 'x' },
        {
          external_url: 'https://elsewhere.example/3',
          content_html: '   ',
          content_text: 'Fallback text',
        },
        null,
      ],
    })}`;
    const result = await parseFeed(text, { url: URL, now: NOW });
    expect(result).toMatchObject({
      ok: true,
      kind: 'json',
      feed: { title: 'Odd' },
      totalItems: 4,
      itemErrors: [{ index: 3, code: 'ITEM_INVALID' }],
      items: [
        { guid: '7', title: 'Text only', link: null, author: 'Feed Author', categories: [] },
        { guid: null, link: 'https://feed.example/2', excerpt: 'Summary only' },
        { link: 'https://elsewhere.example/3', excerpt: 'Fallback text' },
      ],
    });
  });

  it('validates its options', async () => {
    await expect(parseFeed('<rss/>', { url: 'not a url' })).rejects.toThrow(TypeError);
    await expect(parseFeed('<rss/>', { url: URL, now: new Date(Number.NaN) })).rejects.toThrow(
      TypeError,
    );
    await expect(parseFeed('<rss/>', { url: URL, maxItems: 0 })).rejects.toThrow(TypeError);
    await expect(parseFeed('<rss/>', { url: URL, maxItems: 1.5 })).rejects.toThrow(TypeError);
    await expect(parseFeed('<rss/>', { url: URL, deadlineMs: -1 })).rejects.toThrow(TypeError);
  });

  it('defaults now to the current time', async () => {
    const future = new Date(Date.now() + 3 * 86_400_000).toUTCString();
    const result = await parseFeed(
      rss(`<item><title>x</title><pubDate>${future}</pubDate></item>`),
      {
        url: URL,
      },
    );
    expect(result).toMatchObject({ ok: true, items: [{ publishedAt: null }] });
  });
});
