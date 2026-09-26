import { describe, expect, it } from 'vitest';

import { inspectXml } from '../../src/parse/index.js';
import { fixtureText } from './helpers.js';

function nested(depth: number, name = 'e'): string {
  return `${`<${name}>`.repeat(depth)}x${`</${name}>`.repeat(depth)}`;
}

describe('inspectXml (spec 03 §6 XML safety)', () => {
  it('accepts ordinary feeds and reports their depth', () => {
    expect(inspectXml(fixtureText('rss2.xml'))).toEqual({ ok: true, maxDepth: 4 });
    expect(inspectXml(fixtureText('atom.xml'))).toMatchObject({ ok: true });
    expect(inspectXml('')).toEqual({ ok: true, maxDepth: 0 });
  });

  it.each([
    ['<!DOCTYPE rss><rss/>', 'DOCTYPE'],
    ['<?xml version="1.0"?>\n<!doctype rss [<!ENTITY a "b">]><rss/>', 'DOCTYPE'],
    ['<rss><!ENTITY a "b"></rss>', 'ENTITY'],
    ['<rss><!ELEMENT rss ANY></rss>', 'ELEMENT'],
    ['<rss><!ATTLIST rss a CDATA #IMPLIED></rss>', 'ATTLIST'],
    ['<rss><!NOTATION n SYSTEM "x"></rss>', 'NOTATION'],
  ])('rejects %j', (text, keyword) => {
    expect(inspectXml(text)).toEqual({
      ok: false,
      code: 'XML_DECLARATION_FORBIDDEN',
      message: `XML ${keyword} declarations are not allowed`,
    });
  });

  it('ignores declarations inside CDATA sections, comments and escaped text', () => {
    expect(
      inspectXml(
        '<rss><d><![CDATA[<!DOCTYPE html><html>]]></d><!-- <!ENTITY x "y"> --><e>&lt;!DOCTYPE</e></rss>',
      ),
    ).toEqual({ ok: true, maxDepth: 2 });
  });

  it('allows 64 levels of nesting and rejects 65', () => {
    expect(inspectXml(nested(64))).toEqual({ ok: true, maxDepth: 64 });
    expect(inspectXml(nested(65))).toEqual({
      ok: false,
      code: 'XML_TOO_DEEP',
      message: 'XML nesting exceeds 64 levels',
    });
    expect(inspectXml(nested(3), 2)).toMatchObject({ ok: false, code: 'XML_TOO_DEEP' });
  });

  it('counts non-ASCII element names and ignores self-closing tags and quoted ">"', () => {
    expect(inspectXml(nested(65, 'položka'))).toMatchObject({ ok: false, code: 'XML_TOO_DEEP' });
    expect(inspectXml(`<rss>${'<a/>'.repeat(100)}<b t="1 > 0" u='>'>x</b></rss>`)).toEqual({
      ok: true,
      maxDepth: 2,
    });
  });

  it('survives malformed input', () => {
    expect(inspectXml('<rss><!-- unterminated')).toEqual({ ok: true, maxDepth: 1 });
    expect(inspectXml('<rss><![CDATA[ unterminated')).toEqual({ ok: true, maxDepth: 1 });
    expect(inspectXml('<rss><?pi unterminated')).toEqual({ ok: true, maxDepth: 1 });
    expect(inspectXml('<rss><a b="unterminated></rss>')).toEqual({ ok: true, maxDepth: 1 });
    expect(inspectXml('<rss>< 5 <a <b>x</b></rss>')).toMatchObject({ ok: true });
    expect(inspectXml('</a></b><c>')).toEqual({ ok: true, maxDepth: 1 });
    expect(inspectXml('<rss><!foo></rss>')).toEqual({ ok: true, maxDepth: 1 });
  });
});
