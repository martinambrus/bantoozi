import { sha256Hex } from '@bantoozi/shared/server';

import { isTrackingParam } from './tracking-params.js';

/** Why `canonicalizeUrl` rejected an input (spec 03 §5 step 1). */
export type CanonicalizeFailureReason = 'invalid_url' | 'unsupported_scheme' | 'credentials';

/** Result of `canonicalizeUrl`, which never throws. */
export type CanonicalizeResult =
  { ok: true; url: string } | { ok: false; reason: CanonicalizeFailureReason };

/**
 * `canonicalizeUrl` (spec 03 §5): conservative normalization of provably equivalent URL syntax.
 * Redirects and declared canonicals supply further identity evidence; nothing here rewrites a URL
 * in a way that could merge distinct articles.
 *
 * 1. Parse with WHATWG `URL`, resolving `input` against `base` (the feed or page URL). Unparsable
 *    input is `invalid_url`, a scheme other than http(s) is `unsupported_scheme`, and a URL with
 *    userinfo is `credentials` (credentials never enter an identity).
 * 2. WHATWG lower-cases the scheme and host, converts IDN hosts to punycode and drops the default
 *    port. The root dot of a fully qualified host (`example.com.`) is stripped; a host ending in an
 *    empty label (`example.com..`) is not a DNS name and stays as it is, so the result remains a
 *    fixed point of this function. A host that is only `.` is `invalid_url`.
 * 3. The fragment is removed, except a hash-bang fragment (`#!…`), which is kept verbatim.
 * 4. Tracking parameters (`isTrackingParam`, spec 03 §5 step 4) are removed.
 * 5. The other `&`-separated query pairs keep their order and raw encoding, including repeated keys
 *    and empty values; an empty `?` is dropped.
 * 6. The path stays as WHATWG serializes it: repeated and trailing slashes, percent-encoded reserved
 *    characters and case are preserved.
 *
 * HTTP and HTTPS stay distinct, `id`/`page`/`ref`/`source` parameters are kept, AMP URLs stay as
 * they are (only `rel=canonical` fixes AMP) and Google News wrapper URLs are not unwrapped.
 */
export function canonicalizeUrl(input: string, base?: string): CanonicalizeResult {
  const url = URL.parse(input, base);
  if (url === null) return { ok: false, reason: 'invalid_url' };
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported_scheme' };
  }
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials' };

  const host = url.hostname;
  if (host.endsWith('.') && !host.endsWith('..')) {
    if (host === '.') return { ok: false, reason: 'invalid_url' };
    url.hostname = host.slice(0, -1);
  }
  if (!url.hash.startsWith('#!')) url.hash = '';
  // Always assigned: an empty string also removes a bare `?`, which `url.search` reports as ''.
  url.search = stripTrackingParams(url.search);
  return { ok: true, url: url.href };
}

/** Longest canonical URL, in UTF-8 bytes, that is its own `url_key` (D-11). */
export const MAX_PLAIN_URL_KEY_BYTES = 2048;

/** Prefix of the hashed `url_key` of an overlong canonical URL (D-11). */
export const HASHED_URL_KEY_PREFIX = 'sha256:';

/**
 * `url_key` of a canonical URL (spec 03 §5 step 7): the canonical URL itself, **including the
 * scheme**, so HTTP and HTTPS are unified only by a validated redirect or canonical relationship.
 * A canonical URL longer than {@link MAX_PLAIN_URL_KEY_BYTES} UTF-8 bytes uses
 * `'sha256:' + sha256Hex(canonicalUrl)` instead: PostgreSQL's unique B-tree index cannot hold keys
 * of about 2.7 KB, and the hash keeps the identity global and deterministic (D-11). Linkless items
 * use `linklessUrlKey` instead.
 */
export function urlKey(canonicalUrl: string): string {
  return Buffer.byteLength(canonicalUrl, 'utf8') > MAX_PLAIN_URL_KEY_BYTES
    ? `${HASHED_URL_KEY_PREFIX}${sha256Hex(canonicalUrl)}`
    : canonicalUrl;
}

/**
 * Removes tracking pairs from a serialized WHATWG query (`url.search`: `''` or `?…`) without
 * re-encoding it, so signed or order-sensitive queries survive (spec 03 §5 step 5). Returns `''`
 * when no query remains.
 */
function stripTrackingParams(search: string): string {
  const kept = search
    .slice(1)
    .split('&')
    .filter((pair) => !isTrackingPair(pair));
  const query = kept.join('&');
  return query === '' ? '' : `?${query}`;
}

/** A pair is tracking when its percent-decoded name is; a name that fails to decode is kept. */
function isTrackingPair(pair: string): boolean {
  const equals = pair.indexOf('=');
  const rawName = equals === -1 ? pair : pair.slice(0, equals);
  let name: string;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    return false;
  }
  return isTrackingParam(name);
}
