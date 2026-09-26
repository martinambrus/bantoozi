import { PARSE_LIMITS } from './limits.js';

/**
 * Resolves `href` against `base` with the WHATWG URL parser and returns the absolute URL, or `null`
 * unless it is http(s) and at most {@link PARSE_LIMITS.urlChars} long (spec 03 §6, §6.3). Without a
 * `base`, only an already absolute URL is accepted (e.g. an RSS guid used as a permalink).
 */
export function resolveHttpUrl(href: string, base?: string): string | null {
  const value = href.trim();
  if (value === '' || value.length > PARSE_LIMITS.urlChars) return null;
  let url: URL;
  try {
    url = base === undefined ? new URL(value) : new URL(value, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const resolved = url.href;
  return resolved.length > PARSE_LIMITS.urlChars ? null : resolved;
}

/**
 * Applies one `xml:base` step: resolves `xmlBase` against the inherited `base`, so nested
 * `xml:base` attributes form a chain rooted at the final feed URL (spec 03 §6 `link`). An absent or
 * unparseable `xml:base` keeps the inherited base.
 */
export function applyXmlBase(base: string, xmlBase: string | null | undefined): string {
  if (xmlBase === null || xmlBase === undefined || xmlBase.trim() === '') return base;
  try {
    return new URL(xmlBase.trim(), base).href;
  } catch {
    return base;
  }
}
