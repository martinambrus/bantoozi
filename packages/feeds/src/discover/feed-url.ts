import { MAX_PLAIN_URL_KEY_BYTES, canonicalizeUrl } from '../canonical/index.js';
import { ALLOWED_PORTS, isBlockedAddress } from '../http/index.js';

/** Longest accepted feed URL, in UTF-8 bytes (spec 03 §4.1). */
export const MAX_FEED_URL_BYTES = 8192;

/**
 * Longest accepted canonical feed URL, in UTF-8 bytes: `feeds.url` is the feed's identity and a
 * unique B-tree key, which cannot hold keys of about 2.7 KB (D-11, spec 03 §5 step 7).
 */
export const MAX_FEED_IDENTITY_BYTES = MAX_PLAIN_URL_KEY_BYTES;

/**
 * Query parameter names that carry credentials (spec 03 §4, public-feed boundary, accepted owner
 * decision Q3), in lower case; matched case-insensitively after percent-decoding. Opaque secrets
 * under other names cannot be recognized: the client warns and asks the user to confirm the feed
 * is public.
 */
export const CREDENTIAL_PARAMS: readonly string[] = Object.freeze([
  'token',
  'access_token',
  'api_key',
  'auth',
  'password',
]);

const CREDENTIAL_PARAM_SET: ReadonlySet<string> = new Set(CREDENTIAL_PARAMS);

/** Why {@link validateFeedUrl} rejected a URL. */
export type FeedUrlRejection =
  | 'invalid_url'
  | 'unsupported_scheme'
  | 'credentials'
  | 'credential_param'
  | 'blocked_address'
  | 'too_long';

/** Result of {@link validateFeedUrl}, which never throws. */
export type FeedUrlCheck =
  | {
      ok: true;
      /** The feed's identity (`feeds.url`): `canonicalizeUrl` of the URL (spec 03 §5). */
      canonicalUrl: string;
      /**
       * The URL to request (`feeds.fetch_url`): the WHATWG-serialized input with tracking
       * parameters kept, so a signed URL stays valid (spec 03 §5 step 7). The fragment is dropped,
       * because it is never part of an HTTP request.
       */
      fetchUrl: string;
    }
  | { ok: false; reason: FeedUrlRejection };

export interface ValidateFeedUrlOptions {
  /**
   * `FETCH_ALLOW_PRIVATE` (spec 03 §4.9): skip the port allow-list and the address checks, for
   * local fixture servers. Never set in production.
   */
  allowPrivate?: boolean;
}

const utf8Bytes = (value: string): number => Buffer.byteLength(value, 'utf8');

/**
 * Validates a feed URL without network access (spec 03 §4 public-feed boundary and item 1, §5,
 * §11), for discovery input, discovered candidates and OPML entries. In order:
 *
 * 1. at most {@link MAX_FEED_URL_BYTES} bytes, before and after WHATWG serialization (`too_long`);
 * 2. an absolute URL that WHATWG `URL` parses (`invalid_url`), with scheme `http:` or `https:`
 *    (`unsupported_scheme`);
 * 3. no userinfo (`credentials`) and no {@link CREDENTIAL_PARAMS} in the query or the fragment
 *    (`credential_param`): only public, unauthenticated feeds are accepted (owner decision Q3);
 * 4. unless `allowPrivate`: port 80, 443, 8080 or 8443, and an IP-literal host outside the blocked
 *    ranges (`isBlockedAddress`; WHATWG has already normalized `2130706433` and `0x7f.1` to
 *    `127.0.0.1`), and not a `localhost` name, which always resolves to loopback (RFC 6761)
 *    (`blocked_address`). Other hostnames are checked by `safeFetch` when they are resolved;
 * 5. a canonical URL of at most {@link MAX_FEED_IDENTITY_BYTES} bytes (`too_long`, D-11).
 */
export function validateFeedUrl(input: string, options: ValidateFeedUrlOptions = {}): FeedUrlCheck {
  if (utf8Bytes(input) > MAX_FEED_URL_BYTES) return { ok: false, reason: 'too_long' };
  const url = URL.parse(input);
  if (url === null) return { ok: false, reason: 'invalid_url' };
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported_scheme' };
  }
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials' };
  if (utf8Bytes(url.href) > MAX_FEED_URL_BYTES) return { ok: false, reason: 'too_long' };
  if (hasCredentialParam(url)) return { ok: false, reason: 'credential_param' };
  if (options.allowPrivate !== true && !isPublicDestination(url)) {
    return { ok: false, reason: 'blocked_address' };
  }

  const canonical = canonicalizeUrl(url.href);
  if (!canonical.ok) return { ok: false, reason: canonical.reason };
  if (utf8Bytes(canonical.url) > MAX_FEED_IDENTITY_BYTES) return { ok: false, reason: 'too_long' };

  url.hash = '';
  return { ok: true, canonicalUrl: canonical.url, fetchUrl: url.href };
}

/**
 * A form of a rejected feed URL that is safe to show and to log (spec 03 §4.1: raw queries can
 * carry secrets): userinfo and the values of {@link CREDENTIAL_PARAMS} are replaced by `***`, the
 * rest is kept so the user recognizes the entry, and the result is at most 512 characters. An
 * unparsable input is returned as given (trimmed, truncated).
 */
export function redactFeedUrl(input: string): string {
  const trimmed = input.trim();
  const url = URL.parse(trimmed);
  if (url === null) return truncate(trimmed);
  if (url.username !== '' || url.password !== '') {
    url.username = '***';
    url.password = '';
  }
  url.search = redactCredentialValues(url.search);
  url.hash = redactCredentialValues(url.hash);
  return truncate(url.href);
}

const MAX_REDACTED_CHARS = 512;

function truncate(value: string): string {
  return value.length <= MAX_REDACTED_CHARS ? value : `${value.slice(0, MAX_REDACTED_CHARS - 1)}…`;
}

/** Separators of query pairs; `;` is included because some servers split on it too. */
const QUERY_SEPARATORS = /[&;]/;
/** A fragment may hold pairs after `#`, `#!`, `#!/path?`… (OAuth implicit flows use `#token=`). */
const FRAGMENT_SEPARATORS = /[&;?#!/]/;

function hasCredentialParam(url: URL): boolean {
  return (
    url.search.slice(1).split(QUERY_SEPARATORS).some(isCredentialPair) ||
    url.hash.slice(1).split(FRAGMENT_SEPARATORS).some(isCredentialPair)
  );
}

function isCredentialPair(pair: string): boolean {
  const equals = pair.indexOf('=');
  return isCredentialName(equals === -1 ? pair : pair.slice(0, equals));
}

/** The percent-decoded (`+` as space), trimmed, lower-cased name is a credential parameter. */
function isCredentialName(rawName: string): boolean {
  let name = rawName.replaceAll('+', ' ');
  try {
    name = decodeURIComponent(name);
  } catch {
    // A malformed escape is compared as written.
  }
  return CREDENTIAL_PARAM_SET.has(name.trim().toLowerCase());
}

/** Replaces the value of every credential pair in a serialized `?query` or `#fragment`. */
function redactCredentialValues(part: string): string {
  return part.replace(
    /([?#&;!/])([^?#&;!/=]*)=([^&;#]*)/g,
    (match, separator: string, name: string) =>
      isCredentialName(name) ? `${separator}${name}=***` : match,
  );
}

/** Port and IP-literal checks of spec 03 §4.1–§4.2(a), plus RFC 6761 `localhost` names. */
function isPublicDestination(url: URL): boolean {
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (!ALLOWED_PORTS.includes(port)) return false;
  const host = url.hostname;
  const name = host.endsWith('.') ? host.slice(0, -1) : host;
  if (name === 'localhost' || name.endsWith('.localhost')) return false;
  const isIpLiteral = host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host);
  return !isIpLiteral || !isBlockedAddress(host);
}
