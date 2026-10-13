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

/** A feed-looking `<a href>` of an HTML page (spec 03 §10 step 3). Not proof: it is fetched and parsed. */
export interface AnchorFeedLink {
  /** The `href`, resolved against the document base URL; not validated yet. */
  url: string;
  /** The cleaned anchor text or `title` attribute, or `null`. */
  title: string | null;
}

interface AnchorElement extends LinkElement {
  textContent: string | null;
}

interface AnchorDocument {
  querySelector(selectors: string): LinkElement | null;
  querySelectorAll(selectors: string): Iterable<AnchorElement>;
}

/** Path extensions that mark a feed document. */
const FEED_EXTENSION = /\.(rss|rdf|atom|xml)$/i;
/**
 * `feed`, `rss`, `rdf` or `atom` as a whole word of the path or query (`/rss.php?rub=au`,
 * `/feed/`, `?format=atom`), so `/feedback` and `/atomic` do not match.
 */
const FEED_WORD = /(^|[^a-z0-9])(feed|rss|rdf|atom)([^a-z0-9]|$)/i;

/**
 * Feed-looking `<a href>` links of an HTML document, for pages that name their feed only in the
 * body (`<a href="/rss.php?rub=au">RSS</a>`), as the FeedIt prototype's SimplePie locator does.
 * Only http(s) links qualify, whose path ends in `.rss`/`.rdf`/`.atom`/`.xml` or whose path or
 * query contains a feed word. Order: same host before other hosts, then a feed extension before a
 * feed word, then document order; duplicates and the document itself are dropped. The caller
 * fetches and parses every link it keeps.
 */
export function findAnchorFeeds(html: string, documentUrl: string): AnchorFeedLink[] {
  const { document } = parseHTML(html) as unknown as { document: AnchorDocument };
  const base = documentBase(document, documentUrl);
  const host = URL.parse(documentUrl)?.host;
  const seen = new Set<string>([documentUrl]);
  const ranked: Array<{ rank: number; link: AnchorFeedLink }> = [];
  for (const element of document.querySelectorAll('a[href]')) {
    const href = (element.getAttribute('href') ?? '').trim();
    if (href === '' || href.startsWith('#')) continue;
    const url = URL.parse(href, base);
    if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:')) continue;
    url.hash = '';
    const extension = FEED_EXTENSION.test(url.pathname);
    if (!extension && !FEED_WORD.test(url.pathname + url.search)) continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const label = cleanLabel(element.textContent) ?? cleanLabel(element.getAttribute('title'));
    ranked.push({
      rank: (url.host === host ? 0 : 2) + (extension ? 0 : 1),
      link: { url: url.href, title: label },
    });
  }
  return ranked.sort((a, b) => a.rank - b.rank).map((entry) => entry.link);
}
