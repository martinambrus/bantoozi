import { describe, expect, it } from 'vitest';

import { exportOpml, parseOpml, type OpmlSubscription } from '../../src/opml/index.js';

describe('exportOpml', () => {
  it('writes OPML 2.0 with one outline per folder, in first-appearance order', () => {
    const xml = exportOpml(
      [
        { title: 'Loose', xmlUrl: 'https://loose.example/feed', htmlUrl: null, folder: null },
        {
          title: 'A',
          xmlUrl: 'https://a.example/rss',
          htmlUrl: 'https://a.example/',
          folder: 'Tech',
        },
        { title: 'B', xmlUrl: 'https://b.example/atom', htmlUrl: null, folder: 'News' },
        { title: 'C', xmlUrl: 'https://c.example/feed', htmlUrl: '', folder: ' Tech ' },
        { title: 'D', xmlUrl: 'https://d.example/feed', htmlUrl: null, folder: '   ' },
      ],
      { title: 'My feeds', dateCreated: new Date('2026-09-26T10:30:00Z') },
    );
    expect(xml).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<opml version="2.0">',
        '  <head>',
        '    <title>My feeds</title>',
        '    <dateCreated>Sat, 26 Sep 2026 10:30:00 GMT</dateCreated>',
        '  </head>',
        '  <body>',
        '    <outline type="rss" text="Loose" title="Loose" xmlUrl="https://loose.example/feed"/>',
        '    <outline text="Tech" title="Tech">',
        '      <outline type="rss" text="A" title="A" xmlUrl="https://a.example/rss" htmlUrl="https://a.example/"/>',
        '      <outline type="rss" text="C" title="C" xmlUrl="https://c.example/feed"/>',
        '    </outline>',
        '    <outline text="News" title="News">',
        '      <outline type="rss" text="B" title="B" xmlUrl="https://b.example/atom"/>',
        '    </outline>',
        '    <outline type="rss" text="D" title="D" xmlUrl="https://d.example/feed"/>',
        '  </body>',
        '</opml>',
        '',
      ].join('\n'),
    );
  });

  it('uses a default title, omits an absent or invalid dateCreated and handles no subscriptions', () => {
    const expected = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<opml version="2.0">',
      '  <head>',
      '    <title>Bantoozi subscriptions</title>',
      '  </head>',
      '  <body>',
      '  </body>',
      '</opml>',
      '',
    ].join('\n');
    expect(exportOpml([])).toBe(expected);
    expect(exportOpml([], { dateCreated: new Date(Number.NaN) })).toBe(expected);
  });

  it('falls back to the xmlUrl as text when the title is blank', () => {
    const xml = exportOpml([
      { title: '  ', xmlUrl: 'https://e.example/f?a=1&b=2', htmlUrl: null, folder: null },
    ]);
    expect(xml).toContain(
      '<outline type="rss" text="https://e.example/f?a=1&amp;b=2" title="https://e.example/f?a=1&amp;b=2" xmlUrl="https://e.example/f?a=1&amp;b=2"/>',
    );
  });

  it('escapes markup characters and drops characters XML forbids', () => {
    const xml = exportOpml(
      [
        {
          title: `Tom & "Jerry" <script>alert('x')</script>\t\r\n\u0000\u0007\uFFFE end`,
          xmlUrl: 'https://e.example/f?a=1&b=<2>',
          htmlUrl: 'https://e.example/?q="x"',
          folder: `a"b'c<d>&e`,
        },
      ],
      { title: '<Mine> & "yours"' },
    );
    expect(xml).toContain('<title>&lt;Mine&gt; &amp; &quot;yours&quot;</title>');
    expect(xml).toContain(
      '<outline text="a&quot;b&apos;c&lt;d&gt;&amp;e" title="a&quot;b&apos;c&lt;d&gt;&amp;e">',
    );
    expect(xml).toContain(
      'text="Tom &amp; &quot;Jerry&quot; &lt;script&gt;alert(&apos;x&apos;)&lt;/script&gt;&#9;&#13;&#10; end"',
    );
    expect(xml).toContain('xmlUrl="https://e.example/f?a=1&amp;b=&lt;2&gt;"');
    expect(xml).toContain('htmlUrl="https://e.example/?q=&quot;x&quot;"');
    for (const forbidden of ['\u0000', '\u0007', '\uFFFE']) expect(xml).not.toContain(forbidden);
  });

  it('cannot be tricked into emitting extra outlines by a title', () => {
    const xml = exportOpml([
      {
        title: '"/><outline type="rss" text="evil" xmlUrl="https://evil.example/feed"/><x a="',
        xmlUrl: 'https://good.example/feed',
        htmlUrl: null,
        folder: '"><outline xmlUrl="https://evil.example/folder"/>',
      },
    ]);
    const parsed = parseOpml(xml);
    expect(parsed.ok && parsed.entries.map((entry) => entry.url)).toEqual([
      'https://good.example/feed',
    ]);
  });
});

describe('exportOpml → parseOpml round trip', () => {
  const subscriptions: OpmlSubscription[] = [
    {
      title: 'Denník N – správy & názory',
      xmlUrl: 'https://dennikn.sk/feed/',
      htmlUrl: 'https://dennikn.sk/',
      folder: 'Slovenské správy',
    },
    {
      title: 'Aktuality.sk: "Čo sa deje" <dnes>',
      xmlUrl: 'https://www.aktuality.sk/rss/?utm_source=bantoozi&sig=a%2Fb&x=1',
      htmlUrl: null,
      folder: 'Slovenské správy',
    },
    {
      title: "O'Reilly Radar",
      xmlUrl: 'https://www.oreilly.com/radar/feed/index.xml',
      htmlUrl: 'https://www.oreilly.com/radar/',
      folder: 'Tech & <Code>',
    },
    {
      title: 'Loose feed',
      xmlUrl: 'http://loose.example/rss.xml',
      htmlUrl: null,
      folder: null,
    },
    {
      title: 'Ťažké znaky: ľščťžýáíéúäňô ĽŠČŤŽÝÁÍÉÚÄŇÔ',
      xmlUrl: 'https://example.sk/%C5%A5a%C5%BEk%C3%A9/feed',
      htmlUrl: 'https://example.sk/',
      folder: 'Tech & <Code>',
    },
  ];

  it('gives back the same folders, titles and URLs', () => {
    const result = parseOpml(exportOpml(subscriptions, { title: 'Round & trip' }));
    if (!result.ok) throw new Error(result.message);
    expect(result.invalid).toEqual([]);
    expect(result.duplicates).toEqual([]);
    const byUrl = new Map(result.entries.map((entry) => [entry.url, entry]));
    expect(result.entries).toHaveLength(subscriptions.length);
    for (const subscription of subscriptions) {
      expect(byUrl.get(subscription.xmlUrl)).toMatchObject({
        url: subscription.xmlUrl,
        title: subscription.title,
        htmlUrl: subscription.htmlUrl,
        folder: subscription.folder,
      });
    }
    expect(byUrl.get(subscriptions[1]?.xmlUrl ?? '')?.canonicalUrl).toBe(
      'https://www.aktuality.sk/rss/?sig=a%2Fb&x=1',
    );
  });

  it('is stable: exporting the imported entries again gives the same document', () => {
    const first = exportOpml(subscriptions);
    const parsed = parseOpml(first);
    if (!parsed.ok) throw new Error(parsed.message);
    const again = exportOpml(
      parsed.entries.map((entry) => ({
        title: entry.title ?? '',
        xmlUrl: entry.url,
        htmlUrl: entry.htmlUrl,
        folder: entry.folder,
      })),
    );
    expect(again).toBe(first);
  });
});
