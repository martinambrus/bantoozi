import { describe, expect, it } from 'vitest';

import { readFixture } from '@bantoozi/testing';

import { decodeBody } from '../../src/http/index.js';
import type { NormalizedItem, ParseFeedResult } from '../../src/parse/index.js';
import { parseFeed } from '../../src/parse/index.js';
import { parseFeedXml } from '../../src/parse/xml-worker.js';
import { NOW, fixtureText } from './helpers.js';

interface FixtureCase {
  name: string;
  /** Final feed URL (the base for relative links). */
  url: string;
  encoding?: string;
  contentType?: string;
}

/** Every feed fixture of spec 03 §12 and the §13 parsing cases. */
const FIXTURES: FixtureCase[] = [
  { name: 'rss2.xml', url: 'https://blog.example.com/feed/' },
  { name: 'atom.xml', url: 'https://www.example.org/blog/atom.xml' },
  { name: 'rdf.xml', url: 'https://news.example.net/index.rdf' },
  { name: 'jsonfeed-1.1.json', url: 'https://micro.example.com/feed.json' },
  { name: 'jsonfeed-1.0.json', url: 'https://legacy.example.com/feed.json' },
  { name: 'cdata-html.xml', url: 'https://www.dennik.example/rss' },
  { name: 'windows-1250.xml', url: 'https://www.vychod.example/rss', encoding: 'windows-1250' },
  { name: 'iso-8859-2.xml', url: 'https://www.brno-zpravy.example/rss', encoding: 'iso-8859-2' },
  { name: 'bom-utf8.xml', url: 'https://cafe.example.com/feed' },
  { name: 'utf16le.xml', url: 'https://swiat.example/atom', encoding: 'utf-16' },
  { name: 'unescaped-ampersand.xml', url: 'https://fans.example.com/rss' },
  { name: 'relative-links.xml', url: 'https://www.example.com/magazine/feed.xml' },
  { name: 'media-images.xml', url: 'https://media.example.com/feed' },
  { name: 'dates.xml', url: 'https://dates.example.com/feed' },
  { name: 'google-news.xml', url: 'https://news.google.com/rss/search?q=Slovensko&hl=sk' },
  { name: 'linkless.xml', url: 'https://status.example.com/rss' },
  { name: 'zero-items.xml', url: 'https://quiet.example.com/feed' },
  { name: 'leading-junk.xml', url: 'https://legacy-wp.example.com/feed/' },
  { name: 'not-a-feed.html', url: 'https://www.example.com/', contentType: 'text/html' },
  { name: 'doctype-entity.xml', url: 'https://evil.example/rss' },
];

function parseFixture(fixture: FixtureCase): Promise<ParseFeedResult> {
  return parseFeed(fixtureText(fixture.name, fixture.encoding), {
    url: fixture.url,
    contentType: fixture.contentType,
    now: NOW,
  });
}

async function parsedItems(name: string): Promise<NormalizedItem[]> {
  const fixture = FIXTURES.find((candidate) => candidate.name === name);
  if (fixture === undefined) throw new Error(`unknown fixture ${name}`);
  const result = await parseFixture(fixture);
  if (!result.ok) throw new Error(`${name}: ${result.code} ${result.message}`);
  return result.items;
}

describe('feed fixtures (spec 03 §12, §13)', () => {
  it.each(FIXTURES)('$name parses to the expected result', async (fixture) => {
    expect(await parseFixture(fixture)).toMatchSnapshot();
  });
});

describe('fixture expectations', () => {
  it('RSS 2.0: content:encoded, dc:creator, permalink rules, deduplicated categories', async () => {
    const [queue, release, podcast] = await parsedItems('rss2.xml');
    expect(queue?.link).toBe(
      'https://blog.example.com/2026/09/postgres-job-queue/?utm_source=rss&utm_medium=rss',
    );
    expect(queue?.guid).toBe('https://blog.example.com/?p=4812');
    expect(queue?.author).toBe('Jana Nováková');
    expect(queue?.categories).toEqual(['Databases', 'PostgreSQL', 'News & Opinion']);
    expect(queue?.feedBodyText).toContain('The outbox pattern\n\nEvery state change');
    expect(queue?.excerptHtml).not.toContain('<img');
    expect(queue?.imageUrl).toBe(
      'https://blog.example.com/wp-content/uploads/2026/09/queue-diagram.png',
    );
    expect(release?.author).toBe('releases@example.com (Release Team)');
    expect(release?.imageUrl).toBe('https://blog.example.com/media/release-4-2-cover.jpg');
    // An audio enclosure is neither the link nor the image.
    expect(podcast?.link).toBe('https://blog.example.com/podcast/31/');
    expect(podcast?.imageUrl).toBeNull();
    expect(podcast?.publishedAt?.toISOString()).toBe('2026-09-21T04:30:00.000Z');
  });

  it('Atom: xml:base chains, alternate vs enclosure links, type text/html/xhtml, src content', async () => {
    const [tram, brTags, xhtml, draft, outOfLine] = await parsedItems('atom.xml');
    expect(tram?.link).toBe('https://www.example.org/blog/2026/09/tram-stops.html');
    expect(tram?.imageUrl).toBe('https://www.example.org/blog/2026/09/tram-map.jpg');
    expect(tram?.excerptHtml).toContain('href="https://www.example.org/blog/tools/gps.html"');
    expect(tram?.title).toBe('Mapping every tram stop');
    expect(tram?.categories).toEqual(['maps', 'transit']);
    // type="text": markup characters are literal text.
    expect(brTags?.title).toBe("Why <br> tags don't belong in titles");
    expect(brTags?.link).toBe('https://www.example.org/blog/2026/09/br-tags');
    expect(brTags?.excerptHtml).toBe(
      '<p>A plain-text entry.</p><p>It shows &lt;b&gt; literally, &amp; keeps the line<br />break inside the second paragraph.</p>',
    );
    expect(brTags?.author).toBe('Second Author');
    // type="xhtml": mixed content keeps its order; the content's own xml:base applies.
    expect(xhtml?.title).toBe('Inline XHTML stays in order');
    expect(xhtml?.excerpt).toBe(
      'Hello world! See the notes. Mixed content keeps its order <even with CDATA>.',
    );
    expect(xhtml?.excerptHtml).toContain(
      'href="https://static.example.org/posts/xhtml/notes.html"',
    );
    expect(xhtml?.imageUrl).toBe('https://static.example.org/posts/xhtml/figure-1.png');
    // Entries without their own author inherit the feed's (RFC 4287 §4.2.1).
    expect(xhtml?.author).toBe('Mira Example');
    expect(draft?.publishedAt?.toISOString()).toBe('2026-09-22T07:45:00.000Z');
    expect(draft?.link).toBe('https://www.example.org/blog/2026/09/draft');
    expect(outOfLine?.link).toBeNull();
    expect(outOfLine?.excerpt).toBe('Only a PDF is available; this summary is the excerpt.');
  });

  it('RSS 1.0 (RDF): dc:date, dc:subject, rdf:about as identifier and fallback link', async () => {
    const [comet, soil] = await parsedItems('rdf.xml');
    expect(comet?.publishedAt?.toISOString()).toBe('2026-09-25T19:10:00.000Z');
    expect(soil?.link).toBe('https://news.example.net/2026/09/24/soil/');
    expect(soil?.guid).toBe('https://news.example.net/2026/09/24/soil/');
    expect(soil?.categories).toEqual(['Ecology', 'Climate']);
  });

  it('JSON Feed: HTML and text content, attachments that are never links, invalid items', async () => {
    const result = await parseFixture({
      name: 'jsonfeed-1.1.json',
      url: 'https://micro.example.com/feed.json',
    });
    if (!result.ok) throw new Error(result.message);
    expect(result.kind).toBe('json');
    expect(result.itemErrors).toEqual([{ index: 4, code: 'ITEM_INVALID' }]);
    const [html, text, linked, podcast, undated] = result.items;
    expect(html?.excerptHtml).not.toContain('script');
    expect(html?.imageUrl).toBe('https://micro.example.com/uploads/2026/09/danube.jpg');
    expect(html?.categories).toEqual(['beh', 'Bratislava']);
    expect(text?.guid).toBe('1027');
    expect(text?.excerptHtml).toBe(
      '<p>A post without a title.</p><p>It has two paragraphs &amp; a &lt;tag&gt; that stays text.</p>',
    );
    expect(text?.author).toBe('Peter Príklad');
    expect(linked?.link).toBe('https://other.example.net/interesting-article');
    expect(podcast?.link).toBe('https://micro.example.com/podcast/12');
    expect(podcast?.imageUrl).toBe('https://cdn.example.com/podcast/12-cover.jpg');
    expect(undated?.publishedAt).toBeNull();
    expect(undated?.title).toHaveLength(80);
  });

  it('decodes legacy and Unicode encodings (windows-1250, ISO-8859-2, BOM, UTF-16)', async () => {
    const [slovak] = await parsedItems('windows-1250.xml');
    expect(slovak?.title).toBe('Ľudia v Košiciach protestovali proti zdražovaniu MHD');
    expect(slovak?.excerpt).toContain('„Cestovné sa zvýši o 20 %,“');
    const [czech] = await parsedItems('iso-8859-2.xml');
    expect(czech?.title).toBe('Řidiči v Brně budou od pondělí platit za parkování v centru');
    const [bom] = await parsedItems('bom-utf8.xml');
    expect(bom?.title).toBe('Crème brûlée, ranked');
    const [utf16] = await parsedItems('utf16le.xml');
    expect(utf16?.title).toBe('Łódź otwiera nową linię tramwajową 🚋');
  });

  it.each(['windows-1250.xml', 'iso-8859-2.xml', 'bom-utf8.xml', 'utf16le.xml'])(
    '%s decodes from its bytes with decodeBody (no charset header) to the same items',
    async (name) => {
      const fixture = FIXTURES.find((candidate) => candidate.name === name)!;
      const decoded = decodeBody(readFixture('feeds', name), 'application/rss+xml');
      if (!decoded.ok) throw new Error(`${name}: ${decoded.code}`);
      const result = await parseFeed(decoded.text, { url: fixture.url, now: NOW });
      if (!result.ok) throw new Error(`${name}: ${result.code} ${result.message}`);
      expect(result.items).toEqual(await parsedItems(name));
    },
  );

  it('parses a BOM that is still present in the decoded text without the lenient pass', async () => {
    const result = await parseFeed(fixtureText('bom-utf8.xml', 'utf-8', true), {
      url: 'https://cafe.example.com/feed',
      now: NOW,
    });
    expect(result).toMatchObject({ ok: true, lenient: false, totalItems: 1 });
  });

  it('the lenient retry fixes the unescaped-& fixture', async () => {
    const text = fixtureText('unescaped-ampersand.xml');
    // The strict parse alone fails ...
    expect(await parseFeedXml(text, 10_000)).toMatchObject({ ok: false, code: 'XML_MALFORMED' });
    // ... and parseFeed recovers with one lenient retry.
    const result = await parseFeed(text, { url: 'https://fans.example.com/rss', now: NOW });
    if (!result.ok) throw new Error(result.message);
    expect(result.lenient).toBe(true);
    const [anniversary, cdata] = result.items;
    expect(anniversary?.title).toBe("Q&A: Tom & Jerry's 90th anniversary");
    expect(anniversary?.link).toBe('https://fans.example.com/posts?id=90&view=full');
    expect(anniversary?.guid).toBe('fans-90&A');
    expect(anniversary?.excerpt).toBe(
      'Cats & mice & a valid entity, é, é and space. An unknown &bogus; reference.',
    );
    expect(cdata?.title).toBe('CDATA & stays as it is');
    expect(cdata?.excerpt).toBe('AT&T & friends');
  });

  it('the lenient pass removes bounded leading junk before the XML', async () => {
    const result = await parseFixture({
      name: 'leading-junk.xml',
      url: 'https://legacy-wp.example.com/feed/',
    });
    expect(result).toMatchObject({ ok: true, lenient: true, totalItems: 1 });
  });

  it('CDATA-wrapped HTML is sanitized', async () => {
    const [budget, second] = await parsedItems('cdata-html.xml');
    const html = budget?.excerptHtml ?? '';
    for (const forbidden of [
      '<script',
      '<style',
      '<iframe',
      '<form',
      '<object',
      '<embed',
      '<img',
    ]) {
      expect(html).not.toContain(forbidden);
    }
    for (const forbidden of [
      'onclick',
      'onmouseover',
      'style=',
      'class=',
      'srcset',
      'javascript:',
    ]) {
      expect(html).not.toContain(forbidden);
    }
    expect(html).toContain(
      '<a href="https://www.dennik.example/spravy/rozpocet-2027#detail" rel="noopener noreferrer nofollow" target="_blank">článku</a>',
    );
    expect(budget?.title).toBe('Exkluzívne: Mestská rada schválila rozpočet & nové investície');
    expect(budget?.imageUrl).toBe('https://www.dennik.example/foto/2026/09/rozpocet.jpg');
    // A data: image is never the item image; the link that only wrapped it is gone too.
    expect(second?.imageUrl).toBeNull();
    expect(second?.excerptHtml).toBe(
      '<p>Krátka <em>správa</em> s <a href="https://example.com/a?x=1&amp;y=2" rel="noopener noreferrer nofollow" target="_blank">odkazom</a>.</p>',
    );
  });

  it('relative links and images resolve against xml:base and the final feed URL', async () => {
    const [channelBase, itemBase, rootRelative, guidFallback] =
      await parsedItems('relative-links.xml');
    expect(channelBase?.link).toBe('https://www.example.com/magazine/issues/42/cover-story.html');
    expect(channelBase?.imageUrl).toBe('https://www.example.com/magazine/issues/42/cover.jpg');
    expect(itemBase?.link).toBe('https://cdn.example.net/archive/2026/09/letters.html');
    expect(itemBase?.imageUrl).toBe('https://img.example.net/letters.png');
    expect(rootRelative?.link).toBe('https://www.example.com/about/contact');
    expect(guidFallback?.link).toBe('https://www.example.com/magazine/issues/43/');
  });

  it('selects images: enclosure → media:content → media:thumbnail → first <img>', async () => {
    const images = (await parsedItems('media-images.xml')).map((item) => item.imageUrl);
    expect(images).toEqual([
      'https://media.example.com/img/1-enclosure.jpg',
      'https://media.example.com/img/2-media.png',
      'https://media.example.com/img/3-thumb.jpg',
      'https://media.example.com/img/4-large.webp?w=1200',
      'https://media.example.com/img/5-inline.jpg',
      'https://media.example.com/img/6-thumb.jpg',
    ]);
  });

  it('orders newest first; future, missing and malformed dates are unknown and sort last', async () => {
    const items = await parsedItems('dates.xml');
    expect(
      items.map((item) => [item.link?.split('/').pop(), item.publishedAt?.toISOString()]),
    ).toEqual([
      ['skew', '2026-09-27T06:00:00.000Z'],
      ['comment', '2026-09-25T18:30:00.000Z'],
      ['iso', '2026-09-25T16:00:00.250Z'],
      ['no-zone', '2026-09-24T23:59:59.000Z'],
      ['est', '2026-09-24T13:00:00.000Z'],
      ['two-digit', '2026-09-23T07:00:00.000Z'],
      ['dc-fallback', '2026-09-20T08:00:00.000Z'],
      ['undated-1', undefined],
      ['future', undefined],
      ['malformed', undefined],
      ['feb-30', undefined],
      ['undated-2', undefined],
    ]);
  });

  it('keeps Google News wrapper links and opaque GUIDs unchanged', async () => {
    const items = await parsedItems('google-news.xml');
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.link).toMatch(/^https:\/\/news\.google\.com\/rss\/articles\/CBMi[\w-]+\?oc=5$/);
      expect(item.guid).toMatch(/^CBMi[\w-]+$/);
    }
    expect(items[0]?.title).toBe(
      'Tatry: horská služba varuje pred snehom vo vysokých polohách - Správy z hôr',
    );
  });

  it('linkless items keep their identifiers; GUID limits and empty items are item errors', async () => {
    const result = await parseFixture({
      name: 'linkless.xml',
      url: 'https://status.example.com/rss',
    });
    if (!result.ok) throw new Error(result.message);
    expect(result.totalItems).toBe(9);
    expect(result.itemErrors).toEqual([
      { index: 5, code: 'ITEM_GUID_TOO_LONG' },
      { index: 6, code: 'ITEM_EMPTY' },
      { index: 7, code: 'ITEM_EMPTY' },
    ]);
    expect(result.itemErrorCount).toBe(3);
    const bySource = new Map(result.items.map((item) => [item.sourceIndex, item]));
    expect(bySource.get(0)).toMatchObject({ link: null, guid: 'status-2026-09-26-maintenance' });
    expect(bySource.get(1)?.link).toBe('https://status.example.com/incidents/771');
    expect(bySource.get(2)).toMatchObject({ link: null, guid: 'incident/772' });
    expect(bySource.get(3)).toMatchObject({ link: null, guid: null });
    expect(bySource.get(4)?.guid).toHaveLength(600);
    expect(bySource.get(8)).toMatchObject({ title: '(untitled)', guid: 'only-an-id' });
  });

  it('a valid feed without items is a success', async () => {
    const result = await parseFixture({
      name: 'zero-items.xml',
      url: 'https://quiet.example.com/feed',
    });
    expect(result).toMatchObject({ ok: true, items: [], totalItems: 0, itemsTruncated: false });
  });

  it('an HTML page is FEED_NOT_A_FEED', async () => {
    for (const contentType of ['text/html; charset=utf-8', undefined]) {
      const result = await parseFeed(fixtureText('not-a-feed.html'), {
        url: 'https://www.example.com/',
        contentType,
        now: NOW,
      });
      expect(result).toMatchObject({ ok: false, code: 'FEED_NOT_A_FEED' });
    }
  });

  it('a DOCTYPE/ENTITY document is rejected before any parse or lenient pass', async () => {
    const result = await parseFixture({
      name: 'doctype-entity.xml',
      url: 'https://evil.example/rss',
    });
    expect(result).toEqual({
      ok: false,
      code: 'FEED_PARSE_ERROR',
      message: 'XML DOCTYPE declarations are not allowed',
    });
  });
});
