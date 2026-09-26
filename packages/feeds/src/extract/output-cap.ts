import { truncateHtml } from '../parse/index.js';

/** Maximum UTF-8 bytes of `body_text` + `body_html` (spec 02 `article_bodies` CHECK, 10 MiB). */
export const EXTRACT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/** A truncated text is cut at whitespace when there is some within this many final characters. */
const WORD_BOUNDARY_WINDOW = 1024;

export function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Cuts `text` to at most `maxBytes` UTF-8 bytes on a code point boundary (never inside a
 * multi-byte sequence or a surrogate pair), preferring the last whitespace in the final
 * {@link WORD_BOUNDARY_WINDOW} characters so that a word is not split.
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  // `bytes[end]` is the first excluded byte; a continuation byte means a character straddles the cut.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  const cut = bytes.subarray(0, end).toString('utf8');
  const floor = Math.max(0, cut.length - WORD_BOUNDARY_WINDOW);
  for (let index = cut.length - 1; index >= floor; index -= 1) {
    if (/\s/.test(cut[index] ?? '')) return cut.slice(0, index).trimEnd();
  }
  return cut;
}

/**
 * The 10 MiB text + HTML cap of spec 03 §8.1 step 6 with well-formed truncation. The readable text
 * has priority: when it fits alone it is kept whole and `body_html` is cut to the remaining bytes by
 * `truncateHtml` (whole tags only, open elements closed, never inside an entity or a character);
 * otherwise the text is cut on a character boundary and there is no HTML. `truncated` records that
 * the capture is partial.
 */
export function capOutput(
  text: string,
  html: string,
  maxBytes: number,
): { text: string; html: string | null; truncated: boolean } {
  const textBytes = utf8Length(text);
  if (textBytes + utf8Length(html) <= maxBytes) return { text, html, truncated: false };
  if (textBytes >= maxBytes) {
    return { text: truncateUtf8(text, maxBytes), html: null, truncated: true };
  }
  const cut = truncateHtml(html, maxBytes - textBytes, 'utf8').html.trim();
  return { text, html: cut === '' ? null : cut, truncated: true };
}
