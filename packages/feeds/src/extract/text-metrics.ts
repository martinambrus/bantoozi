/**
 * `body_lead` and `word_count` (spec 03 §8.1 step 6). Lengths count Unicode code points, as
 * PostgreSQL's `char_length` does, so a cut never splits a surrogate pair.
 */

/** Maximum length of `body_lead`, in characters. */
export const BODY_LEAD_MAX_CHARS = 1500;

/** A sentence end must come after this many characters to be used as the cut point. */
export const BODY_LEAD_MIN_SENTENCE_CUT = 1000;

const SENTENCE_ENDS = new Set(['.', '!', '?', '…']);

/** Closing quotes and brackets that belong to the sentence they follow (`„Áno.“`, `(Yes!)`). */
const SENTENCE_CLOSERS = new Set(['"', "'", '”', '’', '“', '»', '«', '›', ')', ']']);

const WHITESPACE = /\s/u;

/**
 * `body_lead` (spec 03 §8.1 step 6): the first {@link BODY_LEAD_MAX_CHARS} characters of the trimmed
 * text, cut at the last sentence end (`.` `!` `?` `…`) that lies after character
 * {@link BODY_LEAD_MIN_SENTENCE_CUT} if there is one, otherwise cut hard at the limit.
 *
 * A text that fits is returned whole (trimmed): the sentence cut only replaces a truncation. A
 * sentence end is punctuation, optionally followed by closing quotes/brackets, that is followed by
 * whitespace or the end of the text, so `3.5` and `example.com` are not cut points.
 */
export function bodyLead(text: string): string {
  const trimmed = text.trim();
  // 2 UTF-16 code units per code point at most: enough for the limit plus one lookahead character.
  const chars = Array.from(trimmed.slice(0, (BODY_LEAD_MAX_CHARS + 1) * 2)).slice(
    0,
    BODY_LEAD_MAX_CHARS + 1,
  );
  if (chars.length <= BODY_LEAD_MAX_CHARS) return trimmed;

  for (let index = BODY_LEAD_MAX_CHARS - 1; index >= BODY_LEAD_MIN_SENTENCE_CUT; index -= 1) {
    if (!SENTENCE_ENDS.has(chars[index] ?? '')) continue;
    let end = index + 1;
    while (end < BODY_LEAD_MAX_CHARS && SENTENCE_CLOSERS.has(chars[end] ?? '')) end += 1;
    const next = chars[end];
    if (next === undefined || WHITESPACE.test(next)) return chars.slice(0, end).join('');
  }
  return chars.slice(0, BODY_LEAD_MAX_CHARS).join('').trimEnd();
}

/** `word_count` (spec 03 §8.1 step 6): the number of whitespace-separated tokens. */
export function countWords(text: string): number {
  const token = /\S+/gu;
  let count = 0;
  while (token.exec(text) !== null) count += 1;
  return count;
}
