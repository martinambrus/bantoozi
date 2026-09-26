import { readFixture } from '@bantoozi/testing';
import chardet from 'chardet';
import iconv from 'iconv-lite';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { decodeBody, supportedEncoding } from '../../src/http/decode-body.js';

const PHRASE = 'Žltý kôň úpäl ďábelské ódy';
const MORE = 'Ľúbostné šťastie, ťava a žaba: čučoriedky, ňufák, ôsmy. Ďakujeme!';

const bytes = (value: string, encoding = 'utf-8', addBOM = false): Uint8Array =>
  new Uint8Array(iconv.encode(value, encoding, { addBOM }));

function decoded(input: Uint8Array, contentType?: string): { text: string; encoding: string } {
  const result = decodeBody(input, contentType);
  if (!result.ok) throw new Error(`expected a decoded body, got ${result.message}`);
  return { text: result.text, encoding: result.encoding };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('spec 03 §4 charset decoding (decodeBody)', () => {
  describe('fixtures', () => {
    it('a windows-1250 feed (XML declaration) decodes the Slovak diacritics', () => {
      const result = decoded(readFixture('charset', 'windows-1250.xml'), 'application/rss+xml');
      expect(result.encoding).toBe('windows-1250');
      expect(result.text).toContain(`<title>${PHRASE}</title>`);
      expect(result.text).toContain(MORE);
    });

    it('a <meta charset="windows-1250"> page decodes correctly', () => {
      const result = decoded(readFixture('charset', 'meta-charset.html'), 'text/html');
      expect(result.encoding).toBe('windows-1250');
      expect(result.text).toContain(`<h1>${PHRASE}</h1>`);
      expect(result.text).toContain(MORE);
    });

    it('an http-equiv Content-Type (ISO-8859-2) page decodes correctly', () => {
      const result = decoded(readFixture('charset', 'http-equiv-iso-8859-2.html'), undefined);
      expect(result.encoding).toBe('iso-8859-2');
      expect(result.text).toContain(MORE);
    });

    it('UTF-16LE with a BOM decodes, and the BOM is stripped', () => {
      const result = decoded(readFixture('charset', 'utf-16le-bom.xml'), 'application/xml');
      expect(result.encoding).toBe('utf-16le');
      expect(result.text.startsWith('<?xml version="1.0" encoding="UTF-16"?>')).toBe(true);
      expect(result.text).toContain(PHRASE);
    });

    it('BOM-less UTF-16BE XML is detected from its byte signature, not taken as empty', () => {
      const input = readFixture('charset', 'utf-16be-no-bom.xml');
      expect([...input.subarray(0, 4)]).toEqual([0x00, 0x3c, 0x00, 0x3f]);
      const result = decoded(input, 'text/xml');
      expect(result.encoding).toBe('utf-16be');
      expect(result.text).toContain(`<title>${PHRASE}</title>`);
    });

    it('an undeclared windows-1250 document is sniffed with chardet', () => {
      const result = decoded(readFixture('charset', 'undeclared-windows-1250.txt'), 'text/plain');
      expect(result.encoding).toBe('windows-1250');
      expect(result.text).toContain(PHRASE);
      expect(result.text).toContain(MORE);
    });
  });

  describe('precedence: HTTP charset → BOM → declaration (first 2 KiB) → UTF-8', () => {
    it('the HTTP charset wins over a conflicting XML declaration', () => {
      const xml = `<?xml version="1.0" encoding="windows-1250"?><rss><title>${PHRASE}</title></rss>`;
      const result = decoded(bytes(xml, 'iso-8859-2'), 'application/xml; charset="ISO-8859-2"');
      expect(result.encoding).toBe('iso-8859-2');
      expect(result.text).toContain(PHRASE);
    });

    it('the HTTP charset wins over a BOM (literal spec order)', () => {
      const result = decoded(bytes('<rss/>', 'utf-8', true), 'text/xml; charset=windows-1250');
      expect(result.encoding).toBe('windows-1250');
      // EF BB BF read as windows-1250: the UTF-8 BOM bytes stay visible as text.
      expect(result.text).toBe('ď»ż<rss/>');
    });

    it('an unknown or unsafe HTTP charset is ignored', () => {
      const xml = `<?xml version="1.0" encoding="windows-1250"?><t>${PHRASE}</t>`;
      for (const contentType of [
        'text/xml; charset=x-bogus',
        'text/xml; charset=utf-7',
        'text/xml; charset=',
      ]) {
        const result = decoded(bytes(xml, 'windows-1250'), contentType);
        expect(result.encoding).toBe('windows-1250');
        expect(result.text).toContain(PHRASE);
      }
    });

    it('a BOM wins over a conflicting declaration', () => {
      const xml = `<?xml version="1.0" encoding="windows-1250"?><t>${PHRASE}</t>`;
      const result = decoded(bytes(xml, 'utf-8', true), 'application/xml');
      expect(result.encoding).toBe('utf-8');
      expect(result.text.startsWith('<?xml')).toBe(true);
      expect(result.text).toContain(PHRASE);
      const be = decoded(bytes(xml, 'utf-16be', true), undefined);
      expect(be.encoding).toBe('utf-16be');
      expect(be.text).toContain(PHRASE);
    });

    it('the XML declaration wins over an HTML meta tag in the same document', () => {
      const doc = `<?xml version="1.0" encoding="iso-8859-2"?><html><head><meta charset="windows-1250"></head><body>${MORE}</body></html>`;
      const result = decoded(bytes(doc, 'iso-8859-2'), 'application/xhtml+xml');
      expect(result.encoding).toBe('iso-8859-2');
      expect(result.text).toContain(MORE);
    });

    it('a declaration after the first 2 KiB is not seen', () => {
      const doc = `<html><head>${' '.repeat(2100)}<meta charset="windows-1250"></head><body>ok</body></html>`;
      expect(decoded(bytes(doc, 'utf-8'), 'text/html').encoding).toBe('utf-8');
    });

    it('meta variants: unquoted, single quotes, http-equiv with attributes in any order', () => {
      for (const meta of [
        '<meta charset=windows-1250>',
        "<meta charset='windows-1250'/>",
        '<meta content="text/html; charset=windows-1250" http-equiv="Content-Type">',
        '<META HTTP-EQUIV="Content-Type" CONTENT="text/html;charset=WINDOWS-1250">',
      ]) {
        const doc = `<html><head><meta name="x" content="y">${meta}</head><body>${PHRASE}</body></html>`;
        const result = decoded(bytes(doc, 'windows-1250'), 'text/html');
        expect(result.encoding).toBe('windows-1250');
        expect(result.text).toContain(PHRASE);
      }
    });

    it('a UTF-16 label in an ASCII-compatible document means UTF-8 (HTML prescan rule)', () => {
      const doc = `<html><head><meta charset="utf-16"></head><body>${PHRASE}</body></html>`;
      const result = decoded(bytes(doc, 'utf-8'), 'text/html');
      expect(result.encoding).toBe('utf-8');
      expect(result.text).toContain(PHRASE);
    });

    it('without any declaration the default is UTF-8', () => {
      const result = decoded(bytes(`<rss><title>${PHRASE}</title></rss>`), 'application/rss+xml');
      expect(result).toEqual({ text: `<rss><title>${PHRASE}</title></rss>`, encoding: 'utf-8' });
      expect(decoded(new Uint8Array(0), undefined)).toEqual({ text: '', encoding: 'utf-8' });
    });

    it('JSON content types are always UTF-8', () => {
      const json = JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: PHRASE });
      for (const type of [
        'application/feed+json',
        'application/json; charset=iso-8859-2',
        'application/ld+json',
      ]) {
        expect(decoded(bytes(json), type)).toEqual({ text: json, encoding: 'utf-8' });
      }
    });
  });

  describe('aliases through iconv-lite', () => {
    it.each([
      ['windows-1250', 'windows-1250'],
      ['cp1250', 'cp1250'],
      ['CP1250', 'cp1250'],
      ['iso-8859-2', 'iso-8859-2'],
      ['latin2', 'latin2'],
      ['ISO_8859-2:1987', 'iso_8859-2:1987'],
      ['utf8', 'utf8'],
      ['"UTF-8"', 'utf-8'],
      ['iso-8859-1', 'windows-1252'],
      ['latin1', 'windows-1252'],
      ['us-ascii', 'windows-1252'],
    ])('%s → %s', (label, expected) => {
      expect(supportedEncoding(label)).toBe(expected);
    });

    it.each(['utf-7', 'UTF7', 'base64', 'hex', 'x-unknown', '', 'a'.repeat(50)])(
      'rejects %s',
      (label) => {
        expect(supportedEncoding(label)).toBeUndefined();
      },
    );

    it('decodes each alias of the same bytes identically', () => {
      const input = bytes(MORE, 'windows-1250');
      for (const label of ['windows-1250', 'cp1250', 'Windows-1250']) {
        expect(decoded(input, `text/plain; charset=${label}`).text).toBe(MORE);
      }
      const latin2 = bytes(PHRASE, 'iso-8859-2');
      expect(decoded(latin2, 'text/plain; charset=latin2').text).toBe(PHRASE);
    });

    it('ISO-8859-1 labels decode C1 bytes as windows-1252 punctuation', () => {
      const input = new Uint8Array([0x93, 0x51, 0x94, 0x20, 0x96, 0x20, 0xe9]);
      expect(decoded(input, 'text/html; charset=ISO-8859-1').text).toBe('“Q” – é');
    });
  });

  describe('BOM handling', () => {
    it('strips only a leading BOM', () => {
      const result = decoded(bytes('﻿a﻿b', 'utf-8'), undefined);
      expect(result.text).toBe('a﻿b');
      const declared = decoded(bytes('﻿a﻿b', 'utf-8'), 'text/plain; charset=utf-8');
      expect(declared.text).toBe('a﻿b');
    });
  });

  describe('undeclared legacy documents: chardet only above 0.5 % U+FFFD', () => {
    it('keeps UTF-8 when replacement characters stay at or below 0.5 %', () => {
      const text = `${'a'.repeat(999)}`;
      const input = new Uint8Array([...Buffer.from(text), 0xff]);
      const spy = vi.spyOn(chardet, 'detect');
      const result = decoded(input, 'text/plain');
      expect(result.encoding).toBe('utf-8');
      expect(result.text.endsWith('�')).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    });

    it('never sniffs a declared document, whatever its replacement ratio', () => {
      const spy = vi.spyOn(chardet, 'detect');
      const input = bytes(`${PHRASE} ${MORE}`, 'windows-1250');
      const result = decoded(input, 'text/plain; charset=utf-8');
      expect(result.encoding).toBe('utf-8');
      expect(result.text).toContain('�');
      expect(spy).not.toHaveBeenCalled();
    });

    it('an unsupported detected encoding → FEED_DECODE_ERROR', () => {
      vi.spyOn(chardet, 'detect').mockReturnValue('ISO-2022-JP');
      const result = decodeBody(bytes(`${PHRASE} ${MORE}`, 'windows-1250'), 'text/plain');
      expect(result).toEqual({
        ok: false,
        code: 'FEED_DECODE_ERROR',
        message: 'unsupported character encoding ISO-2022-JP',
      });
    });

    it('an undetectable encoding → FEED_DECODE_ERROR', () => {
      vi.spyOn(chardet, 'detect').mockReturnValue(null);
      const result = decodeBody(bytes(`${PHRASE} ${MORE}`, 'windows-1250'), undefined);
      expect(result).toMatchObject({ ok: false, code: 'FEED_DECODE_ERROR' });
    });

    it('a failing decoder is FEED_DECODE_ERROR, never a throw', () => {
      vi.spyOn(iconv, 'decode').mockImplementation(() => {
        throw new Error('decoder bug');
      });
      expect(decodeBody(bytes('x'), 'text/plain')).toMatchObject({
        ok: false,
        code: 'FEED_DECODE_ERROR',
      });
    });
  });
});
