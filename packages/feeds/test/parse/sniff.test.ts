import { describe, expect, it } from 'vitest';

import { sniffFeed } from '../../src/parse/index.js';
import { firstContentIndex, rootElement } from '../../src/parse/sniff.js';
import { fixtureText } from './helpers.js';

describe('sniffFeed (spec 03 §6, §10)', () => {
  it.each([
    ['<rss version="2.0"><channel/></rss>', 'rss'],
    ['\uFEFF  \n<?xml version="1.0"?>\n<rss version="2.0">', 'rss'],
    ['<?xml version="1.0"?><?xml-stylesheet href="s.xsl"?><!-- c --><rss>', 'rss'],
    [
      '<!DOCTYPE rss PUBLIC "-//Netscape Communications//DTD RSS 0.91//EN" "x.dtd"><rss version="0.91">',
      'rss',
    ],
    ['<!DOCTYPE rss [<!ENTITY a "b">]><rss>', 'rss'],
    ['<feed xmlns="http://www.w3.org/2005/Atom">', 'atom'],
    ['<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">', 'rdf'],
    ['{"version": "https://jsonfeed.org/version/1.1", "items": []}', 'json'],
    ['{"items": [], "version":"https:\\/\\/jsonfeed.org\\/version\\/1"}', 'json'],
    ['{"version": "http://jsonfeed.org/version/1"}', 'json'],
    ['<!DOCTYPE html><html><head></head></html>', 'html'],
    ['<!doctype HTML>\n<body>', 'html'],
    ['<HTML lang="en">', 'html'],
    ['<head><title>x</title></head>', 'html'],
    [
      '<?xml version="1.0"?><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "x"><html>',
      'html',
    ],
    ['{"version": "https://example.com/other"}', null],
    ['{"title": "not a feed"}', null],
    ['[1, 2, 3]', null],
    ['<opml version="2.0">', null],
    ['<svg xmlns="http://www.w3.org/2000/svg">', null],
    ['plain text', null],
    ['', null],
    ['<!-- unterminated', null],
    ['<?xml version="1.0"', null],
    ['<!DOCTYPE x', null],
    ['<!DOCTYPE x [ <!ENTITY a "b"', null],
    ['<', null],
  ])('%j → %s', (text, expected) => {
    expect(sniffFeed(text)).toBe(expected);
  });

  it('uses the Content-Type only for bodies it cannot recognize', () => {
    expect(sniffFeed('<rss version="2.0">', 'text/html; charset=utf-8')).toBe('rss');
    expect(sniffFeed('<div>fragment</div>', 'text/html')).toBe('html');
    expect(sniffFeed('<div>fragment</div>', 'application/xhtml+xml')).toBe('html');
    expect(sniffFeed('<div>fragment</div>')).toBeNull();
    expect(sniffFeed('Service unavailable', 'TEXT/HTML')).toBe('html');
    expect(sniffFeed('', 'text/html')).toBe('html');
    expect(sniffFeed('Service unavailable', 'application/rss+xml')).toBeNull();
    expect(sniffFeed('{"version": "https://jsonfeed.org/version/1"}', 'text/plain')).toBe('json');
  });

  it('recognizes the committed fixtures', () => {
    expect(sniffFeed(fixtureText('rss2.xml'))).toBe('rss');
    expect(sniffFeed(fixtureText('atom.xml'))).toBe('atom');
    expect(sniffFeed(fixtureText('rdf.xml'))).toBe('rdf');
    expect(sniffFeed(fixtureText('jsonfeed-1.1.json'))).toBe('json');
    expect(sniffFeed(fixtureText('jsonfeed-1.0.json'))).toBe('json');
    expect(sniffFeed(fixtureText('utf16le.xml', 'utf-16'))).toBe('atom');
    expect(sniffFeed(fixtureText('bom-utf8.xml', 'utf-8', true))).toBe('rss');
    expect(sniffFeed(fixtureText('not-a-feed.html'))).toBe('html');
    expect(sniffFeed(fixtureText('leading-junk.xml'))).toBeNull();
  });
});

describe('prolog helpers', () => {
  it('finds the first content character after whitespace and byte order marks', () => {
    expect(firstContentIndex('\uFEFF \n <x>')).toBe(4);
    expect(firstContentIndex(' \t\n')).toBe(-1);
  });

  it('reads the root element name after the prolog', () => {
    expect(rootElement('<?xml version="1.0"?>\n<!-- a -->\n<rdf:RDF>', 0)).toEqual({
      name: 'rdf:RDF',
      doctypeHtml: false,
    });
    expect(rootElement('<!DOCTYPE html>\n<html>', 0)).toEqual({ name: 'html', doctypeHtml: true });
    expect(rootElement('text', 0)).toEqual({ name: null, doctypeHtml: false });
  });
});
