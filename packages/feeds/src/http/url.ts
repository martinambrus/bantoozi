import { isIP } from 'node:net';

import { ALLOWED_PORTS, isBlockedAddress } from './address.js';

/** URLs longer than this many bytes are rejected (spec 03 §4.1). */
export const MAX_URL_BYTES = 8192;

const utf8Bytes = (value: string): number => Buffer.byteLength(value, 'utf8');

/** The port a request to `url` connects to: explicit, or the scheme default. */
export function effectivePort(url: URL): number {
  if (url.port !== '') return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

/**
 * The politeness-limiter key of `url` (spec 03 §8.2): `scheme://host:port` with the port always
 * explicit, e.g. `https://example.com:443`, so `https://example.com/` and
 * `https://example.com:443/` share one origin row. IPv6 hosts keep their brackets.
 */
export function originOf(url: URL): string {
  return `${url.protocol}//${url.hostname}:${effectivePort(url)}`;
}

/**
 * A log-safe form of a URL: origin and path only. Queries can carry secrets and must never be
 * logged raw (spec 03 §4.1); a removed query or fragment shows as `?…` / `#…`.
 */
export function redactUrl(url: string | URL): string {
  let parsed: URL;
  try {
    parsed = typeof url === 'string' ? new URL(url) : url;
  } catch {
    return '[invalid URL]';
  }
  const auth = parsed.username !== '' || parsed.password !== '' ? '…@' : '';
  const query = parsed.search === '' ? '' : '?…';
  const fragment = parsed.hash === '' ? '' : '#…';
  return `${parsed.protocol}//${auth}${parsed.host}${parsed.pathname}${query}${fragment}`;
}

/** The IP literal of `url`'s host (IPv6 without brackets), or undefined for a hostname. */
export function hostLiteral(url: URL): string | undefined {
  const { hostname } = url;
  const bare =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return isIP(bare) === 0 ? undefined : bare;
}

/** Outcome of {@link checkRequestUrl}. */
export type UrlCheck =
  { ok: true } | { ok: false; code: 'FEED_INVALID_URL' | 'FEED_BLOCKED_ADDRESS'; message: string };

/**
 * The per-hop request-target checks of spec 03 §4.1–§4.2(a), run on the original URL and on every
 * redirect target before anything is sent: only `http:`/`https:`, no userinfo, at most 8,192 bytes
 * (→ `FEED_INVALID_URL`); a port in {@link ALLOWED_PORTS} and, for an IP-literal host (WHATWG
 * `URL` has already normalized `2130706433` and `0x7f.1` to `127.0.0.1`), a public address
 * (→ `FEED_BLOCKED_ADDRESS`). `allowPrivate` (FETCH_ALLOW_PRIVATE) skips the port and address
 * checks only. Hostnames are validated at connect time by `safeLookup`.
 */
export function checkRequestUrl(url: URL, allowPrivate: boolean): UrlCheck {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, code: 'FEED_INVALID_URL', message: 'only http and https URLs are fetched' };
  }
  if (url.username !== '' || url.password !== '') {
    return {
      ok: false,
      code: 'FEED_INVALID_URL',
      message: 'URLs with credentials (userinfo) are not fetched',
    };
  }
  if (utf8Bytes(url.href) > MAX_URL_BYTES) {
    return {
      ok: false,
      code: 'FEED_INVALID_URL',
      message: `the URL is longer than ${MAX_URL_BYTES} bytes`,
    };
  }
  if (allowPrivate) return { ok: true };
  if (!ALLOWED_PORTS.includes(effectivePort(url))) {
    return {
      ok: false,
      code: 'FEED_BLOCKED_ADDRESS',
      message: `port ${effectivePort(url)} is not allowed`,
    };
  }
  const literal = hostLiteral(url);
  if (literal !== undefined && isBlockedAddress(literal)) {
    return {
      ok: false,
      code: 'FEED_BLOCKED_ADDRESS',
      message: 'the destination address is not public',
    };
  }
  return { ok: true };
}

/** Outcome of {@link parseUrl}. */
export type ParsedUrl = { ok: true; url: URL } | { ok: false; message: string };

/**
 * Parses a URL string (optionally relative to `base`, for `Location` headers) with WHATWG `URL`.
 * Rejects non-strings and inputs longer than {@link MAX_URL_BYTES} before parsing; never throws.
 */
export function parseUrl(input: unknown, base?: URL): ParsedUrl {
  if (typeof input !== 'string') return { ok: false, message: 'the URL is not a string' };
  if (utf8Bytes(input) > MAX_URL_BYTES) {
    return { ok: false, message: `the URL is longer than ${MAX_URL_BYTES} bytes` };
  }
  try {
    return { ok: true, url: base === undefined ? new URL(input) : new URL(input, base) };
  } catch {
    return { ok: false, message: 'the URL cannot be parsed' };
  }
}

/** Request-URL identity for loop detection and validator scoping: the fragment is never sent. */
export function requestKey(url: URL): string {
  const copy = new URL(url.href);
  copy.hash = '';
  return copy.href;
}
