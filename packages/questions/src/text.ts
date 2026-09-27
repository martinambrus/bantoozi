/**
 * Text clean-up for model states (spec 05 §3.1, §6, §7). Lengths count Unicode code points, as
 * PostgreSQL's `char_length` and `packages/feeds`' `body_lead` do, so a cut never splits a surrogate
 * pair. States are hashed, so these functions must stay deterministic: any change to them changes
 * state hashes (and therefore cache compatibility), never question-set hashes.
 */

const WHITESPACE_RUN = /\s+/gu;
const WHITESPACE = /\s/u;

/** How far back a cut may move to reach a word boundary before it cuts hard at the limit. */
export const WORD_BOUNDARY_WINDOW = 80;

/** NFC, every whitespace run (including newlines) collapsed to one space, trimmed. */
export function cleanText(text: string): string {
  return text.normalize('NFC').replace(WHITESPACE_RUN, ' ').trim();
}

/** Length in Unicode code points. */
export function codePointLength(text: string): number {
  let length = 0;
  for (const _ of text) length += 1;
  return length;
}

/**
 * `text` cut to at most `max` code points at a word boundary: a text that fits is returned whole;
 * otherwise the cut moves back to the last whitespace within {@link WORD_BOUNDARY_WINDOW} code
 * points of the limit, or cuts hard at the limit when a single word is longer than that. Trailing
 * whitespace is removed; no ellipsis is added (the model sees a lead, not the whole text).
 */
export function clipAtWordBoundary(text: string, max: number): string {
  if (max <= 0) return '';
  // 2 UTF-16 code units per code point at most: enough for the limit plus one lookahead character.
  const chars = Array.from(text.slice(0, (max + 1) * 2)).slice(0, max + 1);
  if (chars.length <= max) return text;
  const next = chars[max] ?? '';
  if (WHITESPACE.test(next)) return chars.slice(0, max).join('').trimEnd();
  for (let index = max - 1; index > 0 && index >= max - WORD_BOUNDARY_WINDOW; index -= 1) {
    if (WHITESPACE.test(chars[index] ?? '')) return chars.slice(0, index).join('').trimEnd();
  }
  return chars.slice(0, max).join('');
}

/** {@link cleanText} then {@link clipAtWordBoundary}; `null` for a missing or blank text. */
export function boundedText(text: string | null | undefined, max: number): string | null {
  if (text === null || text === undefined) return null;
  const cleaned = clipAtWordBoundary(cleanText(text), max);
  return cleaned === '' ? null : cleaned;
}
