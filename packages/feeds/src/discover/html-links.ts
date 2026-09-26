import { parseHTML } from 'linkedom';

import { cleanLabel, mediaTypeOf } from './text.js';

/** `<link type>` values that declare a feed (spec 03 §10 step 3). */
export const ALTERNATE_FEED_TYPES = [
  'application/rss+xml',
  'application/atom+xml',
  'application/feed+json',
  'application/json',
] as const;

export type AlternateFeedType = (typeof ALTERNATE_FEED_TYPES)[number];

/** A feed declared by an HTML page. Declaring is not proof: every link is fetched and parsed. */
export interface AlternateFeedLink {
  /** The `href`, resolved against the document base URL; not validated yet. */
  url: string;
  /** The cleaned `title` attribute, or `null`. */
  title: string | null;
  type: AlternateFeedType;
}

/** The subset of the linkedom DOM this module reads (the package has no DOM lib types). */
interface LinkElement {
  getAttribute(name: string): string | null;
}

interface LinkDocument {
  querySelector(selectors: string): LinkElement | null;
  querySelectorAll(selectors: string): Iterable<LinkElement>;
}

const ALTERNATE_FEED_TYPE_SET: ReadonlySet<string> = new Set(ALTERNATE_FEED_TYPES);
/** ASCII whitespace separates `rel` tokens (HTML "space-separated tokens"). */
const REL_SEPARATORS = /[\t\n\f\r ]+/;

/**
 * The feeds an HTML document declares with `<link rel="alternate">` (spec 03 §10 step 3), in
 * document order: `rel` contains the `alternate` token (ASCII case-insensitive) and `type` is one
 * of {@link ALTERNATE_FEED_TYPES} (parameters and case ignored). Each `href` is resolved against
 * the first `<base href>` (itself resolved against `documentUrl` and used only when it is
 * http(s)), else against `documentUrl`, the response's final URL. Unresolvable or empty hrefs are
 * skipped; scheme, credential and address checks are the caller's (`validateFeedUrl`).
 */
export function findAlternateFeeds(html: string, documentUrl: string): AlternateFeedLink[] {
  const { document } = parseHTML(html) as unknown as { document: LinkDocument };
  const base = documentBase(document, documentUrl);
  const links: AlternateFeedLink[] = [];
  for (const element of document.querySelectorAll('link[rel][href]')) {
    const rel = (element.getAttribute('rel') ?? '').toLowerCase().split(REL_SEPARATORS);
    if (!rel.includes('alternate')) continue;
    const type = mediaTypeOf(element.getAttribute('type'));
    if (!isAlternateFeedType(type)) continue;
    const href = (element.getAttribute('href') ?? '').trim();
    if (href === '') continue;
    const url = URL.parse(href, base);
    if (url === null) continue;
    links.push({ url: url.href, title: cleanLabel(element.getAttribute('title')), type });
  }
  return links;
}

function isAlternateFeedType(type: string): type is AlternateFeedType {
  return ALTERNATE_FEED_TYPE_SET.has(type);
}

function documentBase(document: LinkDocument, documentUrl: string): string {
  const href = document.querySelector('base[href]')?.getAttribute('href')?.trim();
  if (href === undefined || href === '') return documentUrl;
  const base = URL.parse(href, documentUrl);
  return base !== null && (base.protocol === 'http:' || base.protocol === 'https:')
    ? base.href
    : documentUrl;
}
