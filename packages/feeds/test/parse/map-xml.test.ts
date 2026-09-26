import { describe, expect, it } from 'vitest';

import type { NormalizedItem } from '../../src/parse/index.js';
import { parseFeed } from '../../src/parse/index.js';
import { parseFeedXml } from '../../src/parse/xml-worker.js';
import { asArray, attributeOf, first, textOf } from '../../src/parse/xml-values.js';
import { NOW, rss } from './helpers.js';

const URL = 'https://feed.example/rss';

async function items(text: string): Promise<NormalizedItem[]> {
  const result = await parseFeed(text, { url: URL, now: NOW });
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.items;
}

function atom(entries: string): string {
  return `<feed xmlns="http://www.w3.org/2005/Atom"><title>A</title>${entries}</feed>`;
}

describe('RSS/Atom mapping (spec 03 §6)', () => {
  it('keeps unescaped child markup of RSS titles and descriptions in document order', async () => {
    const [item] = await items(
      rss(
        '<item><title>A <b>bold</b> move</title><link>/a</link>' +
          '<description>Hi <p>para <a href="/x">link</a></p> <![CDATA[<i>cdata</i>]]> tail</description></item>',
      ),
    );
    expect(item?.title).toBe('A bold move');
    expect(item?.excerptHtml).toBe(
      'Hi <p>para <a href="https://feed.example/x" rel="noopener noreferrer nofollow" target="_blank">link</a></p> <i>cdata</i> tail',
    );
  });

  it('strips the namespace prefix of prefixed XHTML content', async () => {
    const [entry] = await items(
      atom(
        '<entry><id>1</id><title type="xhtml"><x:div xmlns:x="http://www.w3.org/1999/xhtml">T <x:em>t</x:em></x:div></title>' +
          '<content type="xhtml"><xhtml:div xmlns:xhtml="http://www.w3.org/1999/xhtml"><xhtml:p>Prefixed <xhtml:b>XHTML</xhtml:b></xhtml:p></xhtml:div></content></entry>',
      ),
    );
    expect(entry?.title).toBe('T t');
    expect(entry?.excerptHtml).toBe('<p>Prefixed <b>XHTML</b></p>');
  });

  it('skips Atom content of a non-text media type and uses the summary', async () => {
    const [entry] = await items(
      atom(
        '<entry><id>2</id><title>Image entry</title><content type="image/png">iVBORw0KGgo=</content>' +
          '<summary type="html">&lt;p&gt;The summary&lt;/p&gt;</summary></entry>' +
          '<entry><id>3</id><title type="html">Plain &amp;amp; text</title><content type="text/plain">Line one\nline two</content></entry>',
      ),
    );
    expect(entry?.excerptHtml).toBe('<p>The summary</p>');
    const [, plain] = await items(
      atom(
        '<entry><id>2</id><title>x</title></entry>' +
          '<entry><id>3</id><title type="html">Plain &amp;amp; text</title><content type="text/plain">Line one\nline two</content></entry>',
      ),
    );
    expect(plain?.title).toBe('Plain & text');
    expect(plain?.excerptHtml).toBe('<p>Line one<br />line two</p>');
  });

  it('accepts an IANA alternate rel IRI and ignores non-HTML alternates', async () => {
    const [entry] = await items(
      atom(
        '<entry><id>4</id><title>t</title>' +
          '<link rel="http://www.iana.org/assignments/relation/alternate" type="text/html; charset=utf-8" href="/iri"/></entry>',
      ),
    );
    expect(entry?.link).toBe('https://feed.example/iri');
  });

  it('ignores an unparseable xml:base and keeps the inherited base', async () => {
    const [item] = await items(
      '<rss version="2.0" xml:base="http://[broken"><channel><title>c</title>' +
        '<item><title>t</title><link>relative/path</link></item></channel></rss>',
    );
    expect(item?.link).toBe('https://feed.example/relative/path');
  });

  it('never uses media without a usable image URL', async () => {
    const [item] = await items(
      rss(
        '<item><title>t</title><media:content xmlns:media="http://search.yahoo.com/mrss/" url="http://[bad"/>' +
          '<media:content xmlns:media="http://search.yahoo.com/mrss/" url="https://m.example/clip.mp4"/>' +
          '<enclosure type="image/jpeg"/></item>',
      ),
    );
    expect(item?.imageUrl).toBeNull();
  });

  it('rejects an item whose only content is markup without text', async () => {
    const result = await parseFeed(rss('<item><title><![CDATA[<b> </b>]]></title></item>'), {
      url: URL,
      now: NOW,
    });
    expect(result).toMatchObject({
      ok: true,
      items: [],
      itemErrors: [{ index: 0, code: 'ITEM_EMPTY' }],
    });
  });

  it('maps RSS 0.91 and RSS channel metadata', async () => {
    expect(
      await parseFeedXml('<rss version="0.91"><channel><title>Old</title></channel></rss>', 10),
    ).toMatchObject({ ok: true, kind: 'rss', feed: { title: 'Old' } });
    const result = await parseFeed(
      '<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel xml:lang="cs">' +
        '<title>Pod</title><link href="https://pod.example/"/><description>&lt;b&gt;Weekly&lt;/b&gt;</description>' +
        '<ttl>abc</ttl><itunes:image href="/art.png"/><item><title>e1</title><itunes:author>Host</itunes:author></item>' +
        '</channel></rss>',
      { url: 'https://pod.example/feed', now: NOW },
    );
    expect(result).toMatchObject({
      ok: true,
      feed: {
        title: 'Pod',
        siteUrl: 'https://pod.example/',
        description: 'Weekly',
        language: 'cs',
        langHint: 'cs',
        iconUrl: 'https://pod.example/art.png',
        ttlMinutes: null,
      },
      items: [{ author: 'Host' }],
    });
  });
});

describe('media objects for video evidence (spec 03 §6.4)', () => {
  const MEDIA = 'xmlns:media="http://search.yahoo.com/mrss/"';

  it('maps RSS enclosures and media:content, also inside media:group', async () => {
    const evidence = (
      await items(
        rss(
          `<item><title>enclosure</title><link>/1</link><enclosure url="/1.mov" type="Video/QuickTime" length="1"/></item>` +
            `<item><title>group</title><link>/2</link><media:group ${MEDIA}><media:content url="/2.mp4" medium="video"/></media:group></item>` +
            `<item><title>typed group</title><link>/3</link><media:group ${MEDIA}><media:content url="/3.webm" type="video/webm"/><media:content url="/3.jpg" medium="image"/></media:group></item>` +
            `<item><title>audio</title><link>/4</link><enclosure url="/4.mp3" type="audio/mpeg"/><media:content ${MEDIA} url="/4.m4a" medium="audio"/></item>` +
            `<item><title>untyped</title><link>/5</link><enclosure url="/5.mp4"/><media:content ${MEDIA} url="/5.mp4"/></item>`,
        ),
      )
    ).map((item) => item.videoEvidence);
    expect(evidence).toEqual([true, true, true, false, false]);
  });

  it('maps Atom link rel="enclosure" and media:group; alternate links are never media', async () => {
    const evidence = (
      await items(
        atom(
          '<entry><id>1</id><title>v</title><link href="/1"/><link rel="enclosure" type="video/mp4" href="/1.mp4"/></entry>' +
            '<entry><id>2</id><title>a</title><link href="/2"/><link rel="enclosure" type="audio/mpeg" href="/2.mp3"/></entry>' +
            `<entry><id>3</id><title>g</title><link href="/3"/><media:group ${MEDIA}><media:content url="/3.mp4" type="video/mp4"/></media:group></entry>` +
            '<entry><id>4</id><title>alt</title><link rel="alternate" type="video/mp4" href="/4.mp4"/><link href="/4"/></entry>',
        ),
      )
    ).map((item) => item.videoEvidence);
    expect(evidence).toEqual([true, false, true, false]);
  });

  it('maps JSON Feed attachments by mime_type', async () => {
    const text = JSON.stringify({
      version: 'https://jsonfeed.org/version/1.1',
      items: [
        {
          id: 'v',
          url: 'https://j.example/v',
          content_text: 'Video post',
          attachments: [{ url: 'https://cdn.example/v.mp4', mime_type: 'VIDEO/MP4' }],
        },
        {
          id: 'a',
          url: 'https://j.example/a',
          content_text: 'Audio post',
          attachments: [
            { url: 'https://cdn.example/a.mp3', mime_type: 'audio/mpeg' },
            { url: 'x' },
          ],
        },
      ],
    });
    const result = await parseFeed(text, { url: 'https://j.example/feed.json', now: NOW });
    if (!result.ok) throw new Error(result.message);
    expect(result.items.map((item) => [item.guid, item.videoEvidence])).toEqual([
      ['v', true],
      ['a', false],
    ]);
  });
});

describe('xml2js value accessors', () => {
  it('read text, arrays and attributes of any shape', () => {
    expect(textOf({ _: 'text', $: { a: '1' } })).toBe('text');
    expect(textOf({ $: { a: '1' }, b: ['x', { _: 'y' }], c: 'z' })).toBe('x y z');
    expect(textOf([3])).toBe('3');
    expect(textOf(true)).toBe('true');
    expect(textOf(null)).toBe('');
    let deep: unknown = 'bottom';
    for (let i = 0; i < 100; i += 1) deep = { child: [deep] };
    expect(textOf(deep)).toBe('');
    expect(asArray(undefined)).toEqual([]);
    expect(asArray('x')).toEqual(['x']);
    expect(first(['a', 'b'])).toBe('a');
    expect(attributeOf({ $: { a: '1', b: 2 } }, 'b')).toBeUndefined();
    expect(attributeOf('text', 'a')).toBeUndefined();
  });
});
