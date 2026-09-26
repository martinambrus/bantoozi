import { describe, expect, it } from 'vitest';

import { XML_WORKER_MARKER, parseFeedXml, toCloneable } from '../../src/parse/xml-worker.js';
import { rss } from './helpers.js';

// The worker module runs in a worker thread under parseFeed (not measured by coverage); these
// tests call its parser directly.
describe('parseFeedXml (worker)', () => {
  it('returns rss-parser output with the raw custom fields', async () => {
    const result = await parseFeedXml(
      rss('<item xml:base="/b/"><title>T</title><guid isPermaLink="false">g</guid></item>'),
      10,
    );
    expect(result).toMatchObject({
      ok: true,
      kind: 'rss',
      rootAttrs: { version: '2.0' },
      rawMarkup: null,
      items: [
        {
          title: 'T',
          bzAttrs: { 'xml:base': '/b/' },
          bzGuid: [{ _: 'g', $: { isPermaLink: 'false' } }],
        },
      ],
    });
  });

  it('supplies raw inner markup, in document order, for text constructs with child elements', async () => {
    const result = await parseFeedXml(
      rss(
        '<item><title>A <b>bold</b> title</title><description>Hi <p>para</p> <![CDATA[<i>x</i>]]> there</description></item>' +
          '<item><title>plain</title></item>',
      ),
      10,
    );
    expect(result).toMatchObject({
      ok: true,
      rawMarkup: [
        { title: 'A <b>bold</b> title', description: 'Hi <p>para</p> <![CDATA[<i>x</i>]]> there' },
        { title: 'plain' },
      ],
    });
  });

  it('supplies raw XHTML for Atom and RDF items', async () => {
    const atom = await parseFeedXml(
      '<feed xmlns="http://www.w3.org/2005/Atom"><entry><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">a <b>b</b> c</div></content></entry></feed>',
      10,
    );
    expect(atom).toMatchObject({
      ok: true,
      kind: 'atom',
      rawMarkup: [{ content: '<div xmlns="http://www.w3.org/1999/xhtml">a <b>b</b> c</div>' }],
    });
    const rdf = await parseFeedXml(
      '<rdf:RDF xmlns:rdf="r"><channel><title>c</title></channel><item><title>x <i>y</i></title></item></rdf:RDF>',
      10,
    );
    expect(rdf).toMatchObject({ ok: true, kind: 'rdf', rawMarkup: [{ title: 'x <i>y</i>' }] });
  });

  it('keeps malformed Atom dates and links without attributes from failing the feed', async () => {
    const result = await parseFeedXml(
      '<feed xmlns="http://www.w3.org/2005/Atom"><link>text</link><entry><published>garbage</published><updated>2026-09-01T00:00:00Z</updated><link>text</link><link href="/x"/></entry></feed>',
      10,
    );
    expect(result).toMatchObject({
      ok: true,
      items: [
        {
          bzPublished: ['garbage'],
          bzUpdated: ['2026-09-01T00:00:00Z'],
          bzLink: [{ $: { href: '/x' } }],
        },
      ],
    });
  });

  it('reports malformed XML, unknown roots and too many items', async () => {
    expect(await parseFeedXml(rss('<item><title>a & b</title></item>'), 10)).toMatchObject({
      ok: false,
      code: 'XML_MALFORMED',
    });
    expect(await parseFeedXml('', 10)).toMatchObject({ ok: false, code: 'XML_MALFORMED' });
    expect(await parseFeedXml('<html><body/></html>', 10)).toMatchObject({
      ok: false,
      code: 'XML_NOT_A_FEED',
    });
    expect(
      await parseFeedXml(rss('<item><title>1</title></item><item><title>2</title></item>'), 1),
    ).toEqual({
      ok: false,
      code: 'XML_TOO_MANY_ITEMS',
      message: 'The feed has more than 1 items',
    });
  });

  it('has a versioned workerData marker', () => {
    expect(XML_WORKER_MARKER).toBe('bantoozi:feed-xml-worker:1');
  });
});

describe('toCloneable', () => {
  it('drops values that cannot be structured-cloned', () => {
    const value = {
      text: 'a',
      fn: String.prototype.link,
      nested: [1, () => 2, { symbol: Symbol('s'), big: 1n, ok: null }],
    };
    const copy = toCloneable(value);
    expect(copy).toEqual({ text: 'a', nested: [1, null, { ok: null }] });
    expect(() => structuredClone(copy)).not.toThrow();
  });
});
