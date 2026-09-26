import { escapeHtml } from './text.js';

const CDATA_SECTION = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
const XHTML_NAMESPACE_PREFIX =
  /\bxmlns:([A-Za-z_][\w.-]*)\s*=\s*["']http:\/\/www\.w3\.org\/1999\/xhtml["']/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * HTML of an Atom `type="xhtml"` construct from its raw inner markup (RFC 4287 §3.1.1.3): the
 * XHTML `div` wrapper is left for the sanitizer to unwrap, CDATA sections are literal text, and
 * elements in a prefixed XHTML namespace (`<xhtml:p>`) lose the prefix. Entity references stay
 * as written; the HTML parser decodes them.
 */
export function xhtmlToHtml(raw: string): string {
  let html = raw.replace(CDATA_SECTION, (_section, text: string) => escapeHtml(text));
  const prefix = XHTML_NAMESPACE_PREFIX.exec(html)?.[1];
  if (prefix !== undefined) {
    html = html.replace(new RegExp(`<(/?)${escapeRegExp(prefix)}:`, 'g'), '<$1');
  }
  return html;
}

/**
 * HTML of an RSS text construct that contains unescaped child markup (a common publisher error):
 * the raw inner markup is already HTML, and CDATA sections inside it hold HTML source.
 */
export function embeddedMarkupToHtml(raw: string): string {
  return raw.replace(CDATA_SECTION, (_section, text: string) => text);
}
