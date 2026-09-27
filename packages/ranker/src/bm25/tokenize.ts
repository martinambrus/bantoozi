import { normalizeText } from '@bantoozi/shared';

import { STOP_WORDS } from './stop-words.js';

/**
 * The BM25 tokenizer (spec 06 §9): `normalizeText` (diacritics stripped, lower-case, every run of
 * non-alphanumerics a single space), split on the spaces, then drop tokens shorter than two
 * characters and stop-words. Documents and queries use the same tokenizer, so they match after
 * normalization (`Batérie` and `baterie`). Duplicates are kept: they are term frequencies.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const token of normalizeText(text).split(' ')) {
    if (isTooShort(token) || STOP_WORDS.has(token)) continue;
    tokens.push(token);
  }
  return tokens;
}

/** Fewer than two code points (a single astral character is two UTF-16 units). */
function isTooShort(token: string): boolean {
  if (token.length < 2) return true;
  return token.length === 2 && (token.codePointAt(0) ?? 0) > 0xffff;
}
