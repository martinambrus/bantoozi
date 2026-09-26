import { describe, expect, it } from 'vitest';

import {
  OPML_MAX_BYTES,
  OPML_MAX_DEPTH,
  OPML_MAX_OUTLINES,
  parseOpml,
  type OpmlImport,
} from '../../src/opml/index.js';

type OpmlSuccess = Extract<OpmlImport, { ok: true }>;

function opml(body: string, head = '<head><title>Subscriptions</title></head>'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">${head}<body>${body}</body></opml>`;
}

function parsed(xml: string, options?: { allowPrivate?: boolean }): OpmlSuccess {
  const result = parseOpml(xml, options);
  if (!result.ok) throw new Error(`expected a parsed OPML, got ${result.code}: ${result.message}`);
  return result;
}

describe('parseOpml: subscriptions', () => {
  it('collects feeds from nested folders in document order with the nearest folder', () => {
    const result = parsed(
      opml(`
        <outline text="Top feed" type="rss" xmlUrl="https://top.example/feed" htmlUrl="https://top.example/"/>
        <outline text="Tech" title="Technology">
          <outline text="Blog A" type="rss" xmlUrl="https://a.example/rss?utm_source=opml&amp;id=7"/>
          <outline title="Deep">
            <outline text="Blog B" xmlUrl="https://b.example/feed.xml"/>
          </outline>
          <outline text="Blog C" xmlUrl="https://c.example/atom"/>
        </outline>
        <outline text="Empty folder"/>
        <outline text="Last" xmlUrl="http://d.example/index.xml"/>`),
    );
    expect(result.entries).toEqual([
      {
        index: 0,
        url: 'https://top.example/feed',
        canonicalUrl: 'https://top.example/feed',
        title: 'Top feed',
        htmlUrl: 'https://top.example/',
        folder: null,
      },
      {
        index: 2,
        url: 'https://a.example/rss?utm_source=opml&id=7',
        canonicalUrl: 'https://a.example/rss?id=7',
        title: 'Blog A',
        htmlUrl: null,
        folder: 'Tech',
      },
      {
        index: 4,
        url: 'https://b.example/feed.xml',
        canonicalUrl: 'https://b.example/feed.xml',
        title: 'Blog B',
        htmlUrl: null,
        folder: 'Deep',
      },
      {
        index: 5,
        url: 'https://c.example/atom',
        canonicalUrl: 'https://c.example/atom',
        title: 'Blog C',
        htmlUrl: null,
        folder: 'Tech',
      },
      {
        index: 7,
        url: 'http://d.example/index.xml',
        canonicalUrl: 'http://d.example/index.xml',
        title: 'Last',
        htmlUrl: null,
        folder: null,
      },
    ]);
    expect(result.duplicates).toEqual([]);
    expect(result.invalid).toEqual([]);
  });

  it('deduplicates by canonical URL: the first outline wins and later ones are reported', () => {
    const result = parsed(
      opml(`
        <outline text="News">
          <outline text="Example" xmlUrl="https://example.com/feed?utm_medium=a"/>
        </outline>
        <outline text="Again" xmlUrl="https://EXAMPLE.com:443/feed#top"/>
        <outline text="Plain http is another feed" xmlUrl="http://example.com/feed"/>
        <outline text="Third copy" xmlUrl="https://example.com/feed?fbclid=x"/>`),
    );
    expect(result.entries.map((entry) => [entry.index, entry.url, entry.folder])).toEqual([
      [1, 'https://example.com/feed?utm_medium=a', 'News'],
      [3, 'http://example.com/feed', null],
    ]);
    expect(result.duplicates).toEqual([
      { index: 2, url: 'https://example.com/feed' },
      { index: 4, url: 'https://example.com/feed?fbclid=x' },
    ]);
  });

  it('reports invalid feed URLs as {index, url, reason} with credentials redacted', () => {
    const long = `https://example.com/${'a'.repeat(8200)}`;
    const longIdentity = `https://example.com/${'b'.repeat(2100)}`;
    const result = parsed(
      opml(`
        <outline text="ftp" xmlUrl="ftp://example.com/feed"/>
        <outline text="userinfo" xmlUrl="https://alice:s3cret@example.com/feed"/>
        <outline text="token" xmlUrl="https://example.com/feed?user=1&amp;token=abc123"/>
        <outline text="API key" xmlUrl="https://example.com/feed?API_KEY=zzz"/>
        <outline text="loopback" xmlUrl="http://127.0.0.1/feed"/>
        <outline text="decimal loopback" xmlUrl="http://2130706433/feed"/>
        <outline text="IPv6 loopback" xmlUrl="http://[::1]/feed"/>
        <outline text="private" xmlUrl="http://10.1.2.3/feed"/>
        <outline text="metadata" xmlUrl="http://169.254.169.254/latest"/>
        <outline text="ssh port" xmlUrl="https://example.com:22/feed"/>
        <outline text="localhost" xmlUrl="http://localhost/feed"/>
        <outline text="too long" xmlUrl="${long}"/>
        <outline text="identity too long" xmlUrl="${longIdentity}"/>
        <outline text="garbage" xmlUrl="not a url"/>
        <outline text="empty" xmlUrl="  "/>
        <outline text="no xmlUrl is a folder, not an error"/>
        <outline text="ok" xmlUrl="https://ok.example/feed"/>`),
    );
    expect(result.invalid.map(({ index, url, reason }) => [index, url, reason])).toEqual([
      [0, 'ftp://example.com/feed', 'unsupported_scheme'],
      [1, 'https://***@example.com/feed', 'credentials'],
      [2, 'https://example.com/feed?user=1&token=***', 'credential_param'],
      [3, 'https://example.com/feed?API_KEY=***', 'credential_param'],
      [4, 'http://127.0.0.1/feed', 'blocked_address'],
      [5, 'http://127.0.0.1/feed', 'blocked_address'],
      [6, 'http://[::1]/feed', 'blocked_address'],
      [7, 'http://10.1.2.3/feed', 'blocked_address'],
      [8, 'http://169.254.169.254/latest', 'blocked_address'],
      [9, 'https://example.com:22/feed', 'blocked_address'],
      [10, 'http://localhost/feed', 'blocked_address'],
      [11, `${long.slice(0, 511)}…`, 'too_long'],
      [12, `${longIdentity.slice(0, 511)}…`, 'too_long'],
      [13, 'not a url', 'invalid_url'],
      [14, '', 'missing_url'],
    ]);
    expect(result.entries.map((entry) => [entry.index, entry.url])).toEqual([
      [16, 'https://ok.example/feed'],
    ]);
  });

  it('accepts private addresses and other ports with allowPrivate (fixture servers)', () => {
    const result = parsed(
      opml('<outline text="fixture" xmlUrl="http://127.0.0.1:43123/feed.xml"/>'),
      { allowPrivate: true },
    );
    expect(result.entries.map((entry) => entry.url)).toEqual(['http://127.0.0.1:43123/feed.xml']);
    expect(result.invalid).toEqual([]);
  });

  it('decodes entities and character references, keeps diacritics and cleans labels', () => {
    const result = parsed(
      opml(`
        <outline text="Správy &amp; &quot;názory&quot; &lt;SK&gt;">
          <outline text="  Denník&#x20;N &#8211; &#x10D;&#233;   " xmlUrl="https://dennikn.sk/feed/?a=1&amp;b=2"/>
          <outline text="" title="Title  fallback" xmlUrl="https://e.example/feed"/>
          <outline xmlUrl="https://f.example/feed"/>
          <outline text="nbsp&nbsp;kept &#0; &#xFFFE; dropped" xmlUrl="https://g.example/feed"/>
        </outline>`),
    );
    expect(result.entries.map(({ title, folder, url }) => ({ title, folder, url }))).toEqual([
      {
        title: 'Denník N – čé',
        folder: 'Správy & "názory" <SK>',
        url: 'https://dennikn.sk/feed/?a=1&b=2',
      },
      { title: 'Title fallback', folder: 'Správy & "názory" <SK>', url: 'https://e.example/feed' },
      { title: null, folder: 'Správy & "názory" <SK>', url: 'https://f.example/feed' },
      {
        title: 'nbsp&nbsp;kept dropped',
        folder: 'Správy & "názory" <SK>',
        url: 'https://g.example/feed',
      },
    ]);
  });

  it('caps labels at 500 code points without splitting a surrogate pair', () => {
    const title = `${'x'.repeat(499)}😀😀`;
    const [entry] = parsed(opml(`<outline text="${title}" xmlUrl="https://e.example/f"/>`)).entries;
    expect(entry?.title).toBe(`${'x'.repeat(499)}😀`);
  });

  it('keeps only http(s) htmlUrls without credentials', () => {
    const result = parsed(
      opml(`
        <outline text="a" xmlUrl="https://a.example/f" htmlUrl=" https://a.example/?x=1&amp;y=2 "/>
        <outline text="b" xmlUrl="https://b.example/f" htmlUrl="javascript:alert(1)"/>
        <outline text="c" xmlUrl="https://c.example/f" htmlUrl="https://user:pw@c.example/"/>
        <outline text="d" xmlUrl="https://d.example/f" htmlUrl="https://d.example/${'p'.repeat(2100)}"/>
        <outline text="e" xmlUrl="https://e.example/f" htmlUrl="nonsense"/>`),
    );
    expect(result.entries.map((entry) => entry.htmlUrl)).toEqual([
      'https://a.example/?x=1&y=2',
      null,
      null,
      null,
      null,
    ]);
  });

  it('matches element and attribute names case-insensitively', () => {
    const result = parsed(`<OPML version="1.0"><Body>
      <Outline TEXT="Folder"><OUTLINE Text="One" XMLURL="https://one.example/rss" HTMLURL="https://one.example/"/></Outline>
      <outline text="Two" xmlurl="https://two.example/rss"/>
    </Body></OPML>`);
    expect(
      result.entries.map(({ title, url, htmlUrl, folder }) => ({ title, url, htmlUrl, folder })),
    ).toEqual([
      {
        title: 'One',
        url: 'https://one.example/rss',
        htmlUrl: 'https://one.example/',
        folder: 'Folder',
      },
      { title: 'Two', url: 'https://two.example/rss', htmlUrl: null, folder: null },
    ]);
  });

  it('uses a feed outline as the folder of outlines nested inside it', () => {
    const result = parsed(
      opml(`<outline text="Parent feed" xmlUrl="https://p.example/feed">
              <outline text="Child" xmlUrl="https://c.example/feed"/>
            </outline>`),
    );
    expect(result.entries.map((entry) => [entry.title, entry.folder])).toEqual([
      ['Parent feed', null],
      ['Child', 'Parent feed'],
    ]);
  });

  it('counts every outline for the index but collects only the first body', () => {
    const result = parsed(`<opml version="2.0">
      <head><outline text="stray" xmlUrl="https://stray.example/feed"/></head>
      <body>
        <outline text="Kept" xmlUrl="https://kept.example/feed"/>
        <group><outline text="Not an outline tree" xmlUrl="https://group.example/feed"/></group>
      </body>
      <body><outline text="Second body" xmlUrl="https://second.example/feed"/></body>
    </opml>`);
    expect(result.entries.map((entry) => [entry.index, entry.title])).toEqual([[1, 'Kept']]);
  });

  it('accepts a BOM, leading whitespace, comments, CDATA and processing instructions', () => {
    const xml = `\uFEFF  \n<?xml version="1.0"?>
      <!-- exported by some reader -->
      <?xml-stylesheet href="style.xsl"?>
      <opml version="1.1"><head><title><![CDATA[My <feeds>]]></title></head>
      <body><outline text="A" xmlUrl="https://a.example/feed"/></body></opml>`;
    expect(parsed(xml).entries.map((entry) => entry.url)).toEqual(['https://a.example/feed']);
  });

  it('returns no entries for an empty body', () => {
    expect(parsed(opml(''))).toEqual({ ok: true, entries: [], duplicates: [], invalid: [] });
    expect(parsed('<opml><body/></opml>').entries).toEqual([]);
  });
});

describe('parseOpml: rejected documents', () => {
  it.each([
    [
      'a DOCTYPE with an entity bomb',
      `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]>
       <opml><body><outline text="&lol2;" xmlUrl="https://e.example/f"/></body></opml>`,
    ],
    ['an external entity', `<!DOCTYPE opml SYSTEM "file:///etc/passwd"><opml><body/></opml>`],
    ['a lower-case doctype', `<!doctype opml><opml><body/></opml>`],
    ['an ENTITY declaration outside a DOCTYPE', `<opml><!ENTITY x "y"><body/></opml>`],
    ['an ELEMENT declaration', `<opml><!ELEMENT opml ANY><body/></opml>`],
    ['an ATTLIST declaration', `<opml><!ATTLIST outline a CDATA "x"><body/></opml>`],
  ])('rejects %s before parsing', (_name, xml) => {
    expect(parseOpml(xml)).toEqual({
      ok: false,
      code: 'OPML_INVALID',
      message: 'DOCTYPE and ENTITY declarations are not allowed in OPML',
    });
  });

  it('ignores declaration-like text inside comments and CDATA', () => {
    const xml = opml(
      '<outline text="a" xmlUrl="https://a.example/feed"/><!-- <!DOCTYPE x [<!ENTITY y "z">]> -->',
      '<head><title><![CDATA[<!ENTITY lol "lol">]]></title></head>',
    );
    expect(parsed(xml).entries.map((entry) => entry.url)).toEqual(['https://a.example/feed']);
  });

  it.each([
    ['an empty string', ''],
    ['plain text', 'just some text'],
    ['a mismatched tag', '<opml><body><outline text="a"></body></opml>'],
    ['an unclosed document', '<opml><body>'],
    ['two roots', '<opml><body/></opml><opml/>'],
    ['a repeated attribute', '<opml><body><outline text="a" text="b"/></body></opml>'],
    ['a bare & in text', '<opml><head><title>Tom & Jerry</title></head><body/></opml>'],
    ['JSON', '{"opml": true}'],
  ])('rejects %s as malformed XML', (_name, xml) => {
    const result = parseOpml(xml);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ code: 'OPML_INVALID' });
  });

  it('reports the line and column of malformed XML', () => {
    expect(parseOpml('<opml>\n<body>\n<outline></body></opml>')).toEqual({
      ok: false,
      code: 'OPML_INVALID',
      message: 'The OPML file is not well-formed XML (line 3, column 10)',
    });
  });

  it('rejects well-formed XML that is not OPML or has no body', () => {
    expect(parseOpml('<rss version="2.0"><channel/></rss>')).toEqual({
      ok: false,
      code: 'OPML_INVALID',
      message: 'The file is not an OPML document',
    });
    expect(
      parseOpml('<html><body><outline xmlUrl="https://e.example/f"/></body></html>'),
    ).toMatchObject({ ok: false, code: 'OPML_INVALID' });
    expect(parseOpml('<opml version="2.0"><head/></opml>')).toEqual({
      ok: false,
      code: 'OPML_INVALID',
      message: 'The OPML document has no body',
    });
  });

  it('rejects an element name the parser refuses', () => {
    expect(parseOpml('<opml><body><__proto__/></body></opml>')).toEqual({
      ok: false,
      code: 'OPML_INVALID',
      message: 'The OPML file cannot be parsed',
    });
  });
});

describe('parseOpml: limits', () => {
  it(`accepts ${OPML_MAX_BYTES} UTF-8 bytes and rejects one more`, () => {
    const prefix = opml('<outline text="a" xmlUrl="https://e.example/f"/>');
    // "č" is two UTF-8 bytes: the limit counts bytes, not UTF-16 code units.
    const filler = (bytes: number): string =>
      `<!--${'č'.repeat(Math.floor(bytes / 2))}${bytes % 2 === 1 ? 'x' : ''}-->`;
    const room = OPML_MAX_BYTES - Buffer.byteLength(prefix, 'utf8') - '<!---->'.length;
    const atLimit = `${prefix}${filler(room)}`;
    expect(Buffer.byteLength(atLimit, 'utf8')).toBe(OPML_MAX_BYTES);
    expect(parsed(atLimit).entries).toHaveLength(1);

    const overLimit = `${prefix}${filler(room + 1)}`;
    expect(Buffer.byteLength(overLimit, 'utf8')).toBe(OPML_MAX_BYTES + 1);
    expect(overLimit.length).toBeLessThan(OPML_MAX_BYTES);
    expect(parseOpml(overLimit)).toEqual({
      ok: false,
      code: 'OPML_TOO_LARGE',
      message: `The OPML file is larger than ${OPML_MAX_BYTES} bytes`,
    });
    expect(parseOpml('x'.repeat(OPML_MAX_BYTES + 1))).toMatchObject({ code: 'OPML_TOO_LARGE' });
  });

  /** `<opml><body>` (depth 2) plus `folders` nested outlines, the innermost holding a feed. */
  function nested(folders: number): string {
    return `<opml><body>${'<outline text="f">'.repeat(folders)}<outline text="feed" xmlUrl="https://deep.example/feed"/>${'</outline>'.repeat(folders)}</body></opml>`;
  }

  it(`accepts nesting of exactly ${OPML_MAX_DEPTH} levels`, () => {
    const result = parsed(nested(OPML_MAX_DEPTH - 3));
    expect(result.entries).toEqual([
      expect.objectContaining({ index: OPML_MAX_DEPTH - 3, folder: 'f', title: 'feed' }),
    ]);
  });

  it.each([OPML_MAX_DEPTH - 2, OPML_MAX_DEPTH - 1, OPML_MAX_DEPTH, OPML_MAX_DEPTH + 50])(
    'rejects %i nested folders (deeper than the limit)',
    (folders) => {
      expect(parseOpml(nested(folders))).toEqual({
        ok: false,
        code: 'OPML_INVALID',
        message: `The OPML file is nested deeper than ${OPML_MAX_DEPTH} levels`,
      });
    },
  );

  it('applies the depth limit outside the body too', () => {
    const deepHead = `<opml><head>${'<x>'.repeat(OPML_MAX_DEPTH - 1)}${'</x>'.repeat(OPML_MAX_DEPTH - 1)}</head><body/></opml>`;
    expect(parseOpml(deepHead)).toMatchObject({ ok: false, code: 'OPML_INVALID' });
  });

  it(`accepts ${OPML_MAX_OUTLINES} outlines and rejects one more`, () => {
    const outlines = (count: number): string =>
      Array.from({ length: count }, (_, i) =>
        i === 0 ? '<outline text="a" xmlUrl="https://e.example/f"/>' : '<outline/>',
      ).join('');
    expect(parsed(opml(outlines(OPML_MAX_OUTLINES))).entries).toHaveLength(1);
    expect(parseOpml(opml(outlines(OPML_MAX_OUTLINES + 1)))).toEqual({
      ok: false,
      code: 'OPML_TOO_LARGE',
      message: `The OPML file has more than ${OPML_MAX_OUTLINES} outlines`,
    });
  });
});
