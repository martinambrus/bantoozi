import type { FeedKind } from './types.js';

/** How far the prolog (declaration, comments, PIs, DOCTYPE) is scanned for the root element. */
const PROLOG_SCAN_CHARS = 64 * 1024;

/** A JSON Feed `version` member (slashes may be JSON-escaped as `\/`). */
const JSON_FEED_VERSION =
  /"version"\s*:\s*"https?:\\?\/\\?\/jsonfeed\.org\\?\/version\\?\/1(?:\.\d+)?\\?\/?"/;

/** JSON Feed version URLs accepted by the parser: 1.0 and 1.x (spec 03 §6). */
export const JSON_FEED_VERSION_URL = /^https?:\/\/jsonfeed\.org\/version\/1(?:\.\d+)?\/?$/;

const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml']);
const HTML_ROOTS = new Set(['html', 'head', 'body']);

/** Index of the first character that is neither whitespace nor a byte order mark, or -1. */
export function firstContentIndex(text: string): number {
  return text.search(/[^\s\uFEFF]/);
}

/**
 * Name of the root element, skipping the XML declaration, processing instructions, comments and a
 * DOCTYPE (with an internal subset); `doctypeHtml` reports an HTML DOCTYPE. `null` when no element
 * starts at `start` after the prolog.
 */
export function rootElement(
  text: string,
  start: number,
): { name: string | null; doctypeHtml: boolean } {
  let i = start;
  let doctypeHtml = false;
  const limit = Math.min(text.length, start + PROLOG_SCAN_CHARS);
  while (i < limit) {
    while (i < limit && /[\s\uFEFF]/.test(text.charAt(i))) i += 1;
    if (text.charAt(i) !== '<') return { name: null, doctypeHtml };
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2);
      if (end < 0) return { name: null, doctypeHtml };
      i = end + 2;
    } else if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end < 0) return { name: null, doctypeHtml };
      i = end + 3;
    } else if (/^<!doctype/i.test(text.slice(i, i + 9))) {
      if (/^<!doctype\s+html\b/i.test(text.slice(i, i + 20))) doctypeHtml = true;
      const subset = text.indexOf('[', i);
      const close = text.indexOf('>', i);
      if (close < 0) return { name: null, doctypeHtml };
      if (subset >= 0 && subset < close) {
        const subsetEnd = text.indexOf(']', subset);
        const end = subsetEnd < 0 ? -1 : text.indexOf('>', subsetEnd);
        if (end < 0) return { name: null, doctypeHtml };
        i = end + 1;
      } else {
        i = close + 1;
      }
    } else {
      const name = /^<([A-Za-z_][\w.:-]*)/.exec(text.slice(i, i + 256))?.[1] ?? null;
      return { name, doctypeHtml };
    }
  }
  return { name: null, doctypeHtml };
}

/** The feed kind of an XML root element name, if it is one. */
export function feedKindOfRoot(name: string | null): Exclude<FeedKind, 'json'> | null {
  if (name === 'rss') return 'rss';
  if (name === 'feed') return 'atom';
  if (name === 'rdf:RDF') return 'rdf';
  return null;
}

/**
 * Sniffs a decoded body (spec 03 §6, §10): the first non-whitespace characters decide — `<rss`,
 * `<feed`, `<rdf:RDF` after any XML prolog, or `{` with a JSON Feed `version` URL. HTML pages
 * (an `<html>`/`<head>`/`<body>` root, an HTML DOCTYPE, or an unrecognized body served as
 * `text/html`) give `'html'`; anything else gives `null`. The `Content-Type` never overrides a
 * recognized body, because servers often mislabel feeds.
 */
export function sniffFeed(text: string, contentType?: string): FeedKind | 'html' | null {
  const mime = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const servedAsHtml = HTML_TYPES.has(mime);
  const start = firstContentIndex(text);
  if (start < 0) return servedAsHtml ? 'html' : null;
  const first = text.charAt(start);
  if (first === '{') return JSON_FEED_VERSION.test(text) ? 'json' : null;
  if (first !== '<') return servedAsHtml ? 'html' : null;
  const root = rootElement(text, start);
  const kind = feedKindOfRoot(root.name);
  if (kind !== null) return kind;
  if (root.doctypeHtml || servedAsHtml) return 'html';
  if (root.name !== null && HTML_ROOTS.has(root.name.toLowerCase())) return 'html';
  return null;
}
