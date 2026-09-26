import { getDomain } from 'tldts';

import { canonicalizeUrl } from '../canonical/index.js';
import { type DomDocument, hasAncestor } from './dom.js';

/**
 * Path segments of section, taxonomy, author, search and archive pages: a canonical pointing at one
 * of them is a list page, not the article (English plus the Slovak/Czech forms of the beta).
 */
const LIST_SEGMENTS = new Set([
  'archive',
  'archives',
  'archiv',
  'author',
  'authors',
  'autor',
  'autori',
  'categories',
  'category',
  'kategoria',
  'kategorie',
  'rubrika',
  'rubriky',
  'search',
  'section',
  'sections',
  'stitky',
  'tag',
  'tags',
  'tagy',
  'tema',
  'temy',
  'topic',
  'topics',
]);

/** Trailing page-path segments that mark an AMP variant of the article its parent path names. */
const AMP_SEGMENTS = new Set(['amp', 'amp.html']);

/**
 * The page's accepted `<link rel="canonical">` (spec 03 §8.1 step 5), canonicalized, or `null`:
 * - only `link` elements outside `<body>` whose `rel` tokens include `canonical` count, and each
 *   `href` is resolved against the document base (`baseUrl`); an empty, unparsable, non-http(s) or
 *   credential-bearing `href` rejects the declaration, and so do several distinct canonicals;
 * - the target must be on the page's registrable domain, computed by `tldts` with the private
 *   suffix list (`alice.github.io` and `bob.github.io` differ), or on exactly the same host (and
 *   port) when either host has no registrable domain (IP addresses, `localhost`);
 * - a home page (`/` without a query), a taxonomy/section/archive/search path
 *   ({@link LIST_SEGMENTS}, `/page/<n>`) or a strict ancestor of the page's own path (other than
 *   the article of an AMP `…/amp` page) is rejected as a list page.
 *
 * A canonical is identity evidence only: it is never fetched here, and the worker still resolves
 * cross-article conflicts before aliasing or merging.
 */
export function detectCanonicalUrl(
  document: DomDocument,
  pageUrl: string,
  baseUrl: string = pageUrl,
): string | null {
  const page = URL.parse(pageUrl);
  if (page === null) return null;

  const candidates = new Set<string>();
  const links = document.querySelectorAll('link[rel]');
  for (let index = 0; index < links.length; index += 1) {
    const link = links[index];
    if (link === undefined || hasAncestor(link, 'body')) continue;
    const rel = (link.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
    if (!rel.includes('canonical')) continue;
    const href = (link.getAttribute('href') ?? '').trim();
    if (href === '') return null;
    const canonical = canonicalizeUrl(href, baseUrl);
    if (!canonical.ok) return null;
    candidates.add(canonical.url);
  }
  const [candidate] = [...candidates];
  const target = candidates.size === 1 && candidate !== undefined ? URL.parse(candidate) : null;
  if (target === null || !sameSite(page, target) || isListTarget(target, page)) return null;
  return target.href;
}

/** Same registrable domain (private suffixes included), or the same host when there is none. */
function sameSite(a: URL, b: URL): boolean {
  const domainA = getDomain(a.hostname, { allowPrivateDomains: true });
  const domainB = getDomain(b.hostname, { allowPrivateDomains: true });
  if (domainA === null || domainB === null) return a.host === b.host;
  return domainA === domainB;
}

function isListTarget(target: URL, page: URL): boolean {
  const segments = pathSegments(target);
  if (target.search === '' && segments.length === 0) return true;
  if (segments.some((segment) => LIST_SEGMENTS.has(segment))) return true;
  if (
    segments.some((segment, index) => segment === 'page' && /^\d+$/.test(segments[index + 1] ?? ''))
  ) {
    return true;
  }
  const pageSegments = pathSegments(page);
  const isAncestor =
    target.search === '' &&
    segments.length < pageSegments.length &&
    segments.every((segment, index) => segment === pageSegments[index]);
  if (!isAncestor) return false;
  const rest = pageSegments.slice(segments.length);
  return !(rest.length === 1 && AMP_SEGMENTS.has(rest[0] ?? ''));
}

function pathSegments(url: URL): string[] {
  return url.pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment).toLowerCase();
      } catch {
        return segment.toLowerCase();
      }
    });
}
