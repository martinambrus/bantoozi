/**
 * Characters XML 1.0 forbids in a document (C0 controls other than TAB, LF and CR, U+FFFE, U+FFFF)
 * and lone surrogates (spec 03 §6, lenient cleanup).
 */
export const XML_FORBIDDEN_CHARS =
  // eslint-disable-next-line no-control-regex -- matching control characters is the purpose
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Invisible characters removed from every text output: the XML-forbidden set plus DEL and the C1
 * controls (typically mis-decoded windows-1252 bytes). PostgreSQL `text` also cannot store NUL.
 */
const CONTROL_CHARS =
  // eslint-disable-next-line no-control-regex -- matching control characters is the purpose
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Removes control characters and lone surrogates; keeps TAB, LF and CR. */
export function stripControlChars(value: string): string {
  return value.replace(CONTROL_CHARS, '');
}

/** Collapses every whitespace run (including NBSP and line breaks) to one space and trims. */
export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/** `collapseWhitespace(stripControlChars(value))`: single-line plain text. */
export function cleanText(value: string): string {
  return collapseWhitespace(stripControlChars(value));
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Number of Unicode code points (PostgreSQL `char_length`), without allocating. */
export function charLength(value: string): number {
  let count = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (isHighSurrogate(value.charCodeAt(i)) && isLowSurrogate(value.charCodeAt(i + 1))) i += 1;
    count += 1;
  }
  return count;
}

/** The first `max` code points of `value` (never splits a surrogate pair). */
export function truncateChars(value: string, max: number): string {
  if (value.length <= max) return value;
  let count = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (count === max) return value.slice(0, i);
    if (isHighSurrogate(value.charCodeAt(i)) && isLowSurrogate(value.charCodeAt(i + 1))) i += 1;
    count += 1;
  }
  return value;
}

/** UTF-8 byte length. */
export function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes text for use in HTML content or a quoted attribute. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}
