import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crc32 } from 'node:zlib';

import { normalizeText } from '@bantoozi/shared';
import { afterEach, describe, expect, it } from 'vitest';

import {
  articleParagraphs,
  buildArticlePage,
  buildRss,
  escapeXml,
  FEED_CATALOGUE,
  FeedInputError,
  startFeed,
  startFeeds,
  type E2eFeed,
  type E2eFeedItem,
} from '../src/e2e/feeds.js';
import { E2E_FEED_KEYS } from '../src/e2e/env.js';
import { solidPng } from '../src/e2e/png.js';

const NOW = new Date('2026-03-10T12:00:00.000Z');
const HOUR_MS = 3_600_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function tokensOf(...texts: string[]): Set<string> {
  const tokens = new Set<string>();
  for (const text of texts) {
    for (const token of normalizeText(text).split(' ')) {
      if ([...token].length >= 4) tokens.add(token);
    }
  }
  return tokens;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('FEED_CATALOGUE', () => {
  const entries = E2E_FEED_KEYS.flatMap((key) =>
    FEED_CATALOGUE[key].items.map((entry) => ({ key, entry })),
  );

  it('has three feeds of three items, exactly one of which carries an image', () => {
    expect(Object.keys(FEED_CATALOGUE)).toEqual([...E2E_FEED_KEYS]);
    for (const key of E2E_FEED_KEYS) {
      const { items } = FEED_CATALOGUE[key];
      expect(items).toHaveLength(3);
      expect(items.filter((item) => item.image)).toHaveLength(1);
    }
    expect(new Set(entries.map(({ entry }) => entry.slug)).size).toBe(9);
  });

  it('dates the items inside the last 48 hours', () => {
    for (const { entry } of entries) {
      expect(entry.ageHours).toBeGreaterThan(0);
      expect(entry.ageHours).toBeLessThan(48);
    }
  });

  it('names one topic word per item that no other item contains', () => {
    for (const { entry } of entries) {
      expect([...entry.topic].length).toBeGreaterThanOrEqual(4);
      expect(tokensOf(entry.title, entry.excerpt).has(normalizeText(entry.topic))).toBe(true);
      const others = entries.filter((other) => other.entry !== entry);
      for (const other of others) {
        expect(
          tokensOf(other.entry.title, other.entry.excerpt).has(normalizeText(entry.topic)),
        ).toBe(false);
      }
    }
  });

  it('keeps every excerpt within the 300 characters of the list DTO', () => {
    for (const { entry } of entries) expect(entry.excerpt.length).toBeLessThanOrEqual(300);
  });
});

describe('solidPng', () => {
  function chunks(png: Buffer): Array<{ type: string; data: Buffer; crc: number }> {
    const out: Array<{ type: string; data: Buffer; crc: number }> = [];
    for (let at = PNG_SIGNATURE.length; at < png.length;) {
      const length = png.readUInt32BE(at);
      out.push({
        type: png.toString('latin1', at + 4, at + 8),
        data: png.subarray(at + 8, at + 8 + length),
        crc: png.readUInt32BE(at + 8 + length),
      });
      at += 12 + length;
    }
    return out;
  }

  it('is a valid PNG: signature, IHDR, IDAT, IEND, each chunk with its CRC', () => {
    const png = solidPng('seed', 120, 80);
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    const parts = chunks(png);
    expect(parts.map((part) => part.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    const header = parts[0]?.data as Buffer;
    expect(header.readUInt32BE(0)).toBe(120);
    expect(header.readUInt32BE(4)).toBe(80);
    for (const part of parts) {
      expect(part.crc).toBe(crc32(Buffer.concat([Buffer.from(part.type, 'latin1'), part.data])));
    }
  });

  it('is deterministic per seed and differs between seeds', () => {
    expect(solidPng('a').equals(solidPng('a'))).toBe(true);
    expect(solidPng('a').equals(solidPng('b'))).toBe(false);
  });
});

describe('escapeXml', () => {
  it('escapes the five XML special characters', () => {
    expect(escapeXml(`A&B <i> "q" 'a'`)).toBe('A&amp;B &lt;i&gt; &quot;q&quot; &apos;a&apos;');
  });
});

describe('article pages', () => {
  const item = (slug: string, imageUrl: string | null = null): E2eFeedItem => ({
    slug,
    guid: `urn:test:${slug}`,
    title: 'A <fine> & "quoted" title',
    excerpt: 'The excerpt.',
    topic: 'fine',
    url: `http://127.0.0.1:1/articles/${slug}.html`,
    imageUrl,
    publishedAt: NOW.toISOString(),
  });

  function words(html: string): number {
    const paragraphs = [...html.matchAll(/<p>([^<]*)<\/p>/g)].map((m) => m[1] ?? '');
    return paragraphs.join(' ').split(/\s+/).filter(Boolean).length;
  }

  it('has at least three paragraphs and 400 words, the excerpt first', () => {
    const paragraphs = articleParagraphs(item('one'));
    expect(paragraphs.length).toBeGreaterThanOrEqual(3);
    expect(paragraphs[0]).toBe('The excerpt.');
    const page = buildArticlePage('Feed', item('one'));
    expect(words(page)).toBeGreaterThanOrEqual(400);
    expect(page.match(/<p>/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('escapes the title and differs between slugs', () => {
    const page = buildArticlePage('Feed', item('one'));
    expect(page).toContain('<h1>A &lt;fine&gt; &amp; &quot;quoted&quot; title</h1>');
    expect(page).not.toContain('<fine>');
    expect(articleParagraphs(item('one'))).not.toEqual(articleParagraphs(item('two')));
  });

  it('puts the topic word into the text and the image into the article', () => {
    expect(buildArticlePage('Feed', item('one')).match(/\bfine\b/g)?.length).toBeGreaterThan(1);
    expect(buildArticlePage('Feed', item('one'))).not.toContain('<img');
    expect(buildArticlePage('Feed', item('one', 'http://127.0.0.1:1/img/one.png'))).toContain(
      '<img src="http://127.0.0.1:1/img/one.png"',
    );
  });
});

describe('buildRss', () => {
  const items: E2eFeedItem[] = [
    {
      slug: 'a',
      guid: 'urn:test:a',
      title: 'Fish & "chips"',
      excerpt: 'Tasty <b>food</b>',
      topic: 'food',
      url: 'http://127.0.0.1:1/articles/a.html',
      imageUrl: 'http://127.0.0.1:1/img/a.png',
      publishedAt: '2026-03-10T10:00:00.000Z',
    },
    {
      slug: 'b',
      guid: 'urn:test:b',
      title: 'Plain',
      excerpt: 'Text',
      topic: 'text',
      url: 'http://127.0.0.1:1/articles/b.html',
      imageUrl: null,
      publishedAt: '2026-03-09T10:00:00.000Z',
    },
  ];
  const xml = buildRss({
    title: 'Feed & Co',
    link: 'http://127.0.0.1:1/',
    description: 'Fixture',
    builtAt: NOW,
    items,
  });

  it('is an RSS 2.0 document with one item per entry, in the given order', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0">')).toBe(
      true,
    );
    expect(xml.match(/<item>/g)).toHaveLength(2);
    expect(xml.indexOf('urn:test:a')).toBeLessThan(xml.indexOf('urn:test:b'));
    expect(xml).toContain('<title>Feed &amp; Co</title>');
    expect(xml).toContain('<guid isPermaLink="false">urn:test:a</guid>');
    expect(xml).toContain('<link>http://127.0.0.1:1/articles/a.html</link>');
  });

  it('writes RFC 822 dates', () => {
    expect(xml).toContain('<pubDate>Tue, 10 Mar 2026 10:00:00 GMT</pubDate>');
    expect(xml).toContain('<lastBuildDate>Tue, 10 Mar 2026 12:00:00 GMT</lastBuildDate>');
  });

  it('escapes titles and carries the excerpt as escaped HTML, with the image when there is one', () => {
    expect(xml).toContain('<title>Fish &amp; &quot;chips&quot;</title>');
    expect(xml).toContain(
      '<description>&lt;p&gt;Tasty &amp;lt;b&amp;gt;food&amp;lt;/b&amp;gt;&lt;/p&gt;&lt;img src=&quot;http://127.0.0.1:1/img/a.png&quot; alt=&quot;&quot;&gt;</description>',
    );
    expect(xml).toContain('<description>&lt;p&gt;Text&lt;/p&gt;</description>');
  });
});

describe('a running feed', () => {
  const started: E2eFeed[] = [];

  async function start(
    key: 'tech' | 'science' | 'culture' = 'tech',
    options: { port?: number } = {},
  ): Promise<E2eFeed> {
    const feed = await startFeed(key, { now: () => NOW, ...options });
    started.push(feed);
    return feed;
  }

  afterEach(async () => {
    await Promise.all(started.splice(0).map((feed) => feed.close()));
  });

  const get = (feed: E2eFeed, path: string) => fetch(new URL(path, feed.origin));

  it('serves a dated, newest-first RSS document on its own loopback origin', async () => {
    const feed = await start();
    expect(feed.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(feed.url).toBe(`${feed.origin}/feed.xml`);
    const response = await fetch(feed.url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/rss+xml; charset=utf-8');
    const xml = await response.text();
    expect(xml.match(/<item>/g)).toHaveLength(3);
    const titles = [...xml.matchAll(/<item>\n<title>([^<]*)<\/title>/g)].map((m) => m[1]);
    expect(titles).toEqual(FEED_CATALOGUE.tech.items.map((entry) => entry.title));
    for (const entry of FEED_CATALOGUE.tech.items) {
      const published = new Date(NOW.getTime() - entry.ageHours * HOUR_MS).toUTCString();
      expect(xml).toContain(`<pubDate>${published}</pubDate>`);
    }
  });

  it('allows every robot', async () => {
    const feed = await start();
    const response = await get(feed, '/robots.txt');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('User-agent: *\nDisallow:\n');
  });

  it('serves each article page and the image of the one item that has one', async () => {
    const feed = await start();
    const page = await get(feed, '/articles/tech-quantum.html');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await page.text()).toContain(
      '<h1>Quantum processors pass a thousand stable qubits</h1>',
    );

    const image = await get(feed, '/img/tech-robotics.png');
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(
      Buffer.from(await image.arrayBuffer())
        .subarray(0, 8)
        .equals(PNG_SIGNATURE),
    ).toBe(true);

    expect((await get(feed, '/img/tech-quantum.png')).status).toBe(404);
    expect((await get(feed, '/articles/nothing.html')).status).toBe(404);
  });

  it('lists the catalogue items with their page and image URLs', async () => {
    const feed = await start('science');
    const items = feed.items();
    expect(items.map((item) => item.slug)).toEqual([
      'science-exoplanet',
      'science-glacier',
      'science-enzyme',
    ]);
    expect(items[1]?.imageUrl).toBe(`${feed.origin}/img/science-glacier.png`);
    expect(items[0]?.imageUrl).toBeNull();
    expect(items[0]?.url).toBe(`${feed.origin}/articles/science-exoplanet.html`);
    expect(items[0]?.publishedAt).toBe(new Date(NOW.getTime() - 3 * HOUR_MS).toISOString());
  });

  it('listens on the port it is given', async () => {
    const port = await freePort();
    const feed = await start('culture', { port });
    expect(feed.origin).toBe(`http://127.0.0.1:${port}`);
  });

  describe('append', () => {
    it('adds an item at the top of the feed with its page and image', async () => {
      const feed = await start();
      const item = feed.append({ title: 'Zeppelin revival takes off', image: true });
      expect(item.slug).toBe('tech-extra-1');
      expect(item.topic).toBe('zeppelin');
      expect(item.excerpt).toBe('Zeppelin revival takes off.');
      expect(item.publishedAt).toBe(NOW.toISOString());
      expect(feed.items()[0]).toEqual(item);

      const xml = await (await fetch(feed.url)).text();
      expect(xml.match(/<item>/g)).toHaveLength(4);
      expect(xml.indexOf('Zeppelin revival')).toBeLessThan(xml.indexOf('Quantum processors'));
      expect((await get(feed, '/articles/tech-extra-1.html')).status).toBe(200);
      expect((await get(feed, '/img/tech-extra-1.png')).status).toBe(200);
    });

    it('takes an explicit slug, topic, excerpt and date', async () => {
      const feed = await start();
      const item = feed.append({
        title: 'Old news',
        excerpt: 'Dusty.',
        slug: 'old-news',
        topic: 'dusty',
        publishedAt: '2026-03-01T00:00:00Z',
      });
      expect(item).toMatchObject({
        slug: 'old-news',
        topic: 'dusty',
        excerpt: 'Dusty.',
        publishedAt: '2026-03-01T00:00:00.000Z',
        imageUrl: null,
      });
      expect(feed.items().at(-1)).toEqual(item);
    });

    it('never reuses a default slug, not even after a reset', () => {
      return start().then((feed) => {
        expect(feed.append({ title: 'One' }).slug).toBe('tech-extra-1');
        feed.reset();
        expect(feed.append({ title: 'Two' }).slug).toBe('tech-extra-2');
      });
    });

    it('does not count a rejected item', async () => {
      const feed = await start();
      expect(() => feed.append({ title: '' })).toThrow(FeedInputError);
      expect(feed.append({ title: 'Fine' }).slug).toBe('tech-extra-1');
    });

    it.each([
      ['an empty title', { title: '' }, /title must be 1-200/],
      ['a blank title', { title: '   ' }, /title must be 1-200/],
      ['a title with a control character', { title: 'a\u0007b' }, /title must be 1-200/],
      ['a title of 201 characters', { title: 'x'.repeat(201) }, /title must be 1-200/],
      ['an excerpt of 301 characters', { title: 'ok', excerpt: 'x'.repeat(301) }, /excerpt/],
      ['an upper-case slug', { title: 'ok', slug: 'Bad' }, /slug must match/],
      ['a slug with a path', { title: 'ok', slug: '../x' }, /slug must match/],
      ['a slug of a catalogue item', { title: 'ok', slug: 'tech-quantum' }, /already used/],
      ['an invalid date', { title: 'ok', publishedAt: 'yesterday' }, /ISO 8601/],
    ])('rejects %s', async (_name, input, message) => {
      const feed = await start();
      expect(() => feed.append(input)).toThrow(FeedInputError);
      expect(() => feed.append(input)).toThrow(message);
      expect(feed.items()).toHaveLength(3);
    });
  });

  describe('script', () => {
    it('answers a path with a failure status and restores it with null', async () => {
      const feed = await start();
      feed.script('/feed.xml', 503);
      expect((await get(feed, '/feed.xml')).status).toBe(503);
      expect((await get(feed, '/articles/tech-quantum.html')).status).toBe(200);
      feed.script('/feed.xml', null);
      const restored = await get(feed, '/feed.xml');
      expect(restored.status).toBe(200);
      expect(await restored.text()).toContain('<rss');
    });

    it('can fail an article page and an item appended later', async () => {
      const feed = await start();
      feed.script('/articles/tech-quantum.html', 404);
      expect((await get(feed, '/articles/tech-quantum.html')).status).toBe(404);
      feed.script('/articles/tech-extra-1.html', 410);
      feed.append({ title: 'Later' });
      expect((await get(feed, '/articles/tech-extra-1.html')).status).toBe(410);
    });

    it('can fail a path the feed does not serve, and clear it again', async () => {
      const feed = await start();
      feed.script('/missing', 500);
      expect((await get(feed, '/missing')).status).toBe(500);
      feed.script('/missing', null);
      expect((await get(feed, '/missing')).status).toBe(404);
    });

    it.each([200, 399, 600, 1.5, Number.NaN])('rejects the status %s', async (status) => {
      const feed = await start();
      expect(() => feed.script('/feed.xml', status)).toThrow(/status must be an integer/);
    });

    it.each(['feed.xml', '/feed.xml?x=1', `/${'a'.repeat(200)}`])(
      'rejects the path %j',
      async (path) => {
        const feed = await start();
        expect(() => feed.script(path, 500)).toThrow(/path must start with/);
      },
    );
  });

  it('logs every request with its method, path, user agent and referer', async () => {
    const feed = await start();
    await fetch(feed.url, {
      headers: { 'user-agent': 'probe/1', referer: 'http://example.test/' },
    });
    await get(feed, '/robots.txt');
    const [first, second] = feed.requests();
    expect(first).toMatchObject({
      method: 'GET',
      path: '/feed.xml',
      userAgent: 'probe/1',
      referer: 'http://example.test/',
    });
    expect(second).toMatchObject({ path: '/robots.txt', referer: null });
    expect(Date.parse(first?.at ?? '')).not.toBeNaN();
  });

  it('forgets appended items, scripted failures and the request log on reset', async () => {
    const feed = await start();
    feed.append({ title: 'Temporary' });
    feed.script('/feed.xml', 500);
    await get(feed, '/robots.txt');
    feed.reset();
    expect(feed.requests()).toEqual([]);
    expect(feed.items()).toHaveLength(3);
    expect((await get(feed, '/feed.xml')).status).toBe(200);
    expect((await get(feed, '/articles/tech-extra-1.html')).status).toBe(404);
    expect((await get(feed, '/articles/tech-quantum.html')).status).toBe(200);
  });
});

describe('startFeeds', () => {
  it('starts the three feeds on the given ports', async () => {
    const ports = {
      tech: await freePort(),
      science: await freePort(),
      culture: await freePort(),
    };
    const feeds = await startFeeds(ports, { now: () => NOW });
    try {
      for (const key of E2E_FEED_KEYS) {
        expect(feeds[key].key).toBe(key);
        expect(feeds[key].origin).toBe(`http://127.0.0.1:${ports[key]}`);
        expect((await fetch(feeds[key].url)).status).toBe(200);
      }
    } finally {
      await Promise.all(E2E_FEED_KEYS.map((key) => feeds[key].close()));
    }
  });

  it('closes the feeds it started when one port is taken', async () => {
    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve));
    const busy = (taken.address() as AddressInfo).port;
    const free = { tech: await freePort(), science: await freePort() };
    try {
      await expect(startFeeds({ ...free, culture: busy })).rejects.toThrow(/EADDRINUSE/);
      for (const port of Object.values(free)) {
        await expect(fetch(`http://127.0.0.1:${port}/feed.xml`)).rejects.toThrow();
      }
    } finally {
      await new Promise<void>((resolve) => taken.close(() => resolve()));
    }
  });
});
