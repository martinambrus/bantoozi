import { RULE_KEYWORD_MAX, RULE_KEYWORD_MIN } from '@bantoozi/shared';

/** The distinct words of a title that a keyword rule can hold, as written the first time. */
export function titleWords(title: string): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const [word] of title.matchAll(/[\p{L}\p{N}]+/gu)) {
    const key = word.toLowerCase();
    if (word.length < RULE_KEYWORD_MIN || word.length > RULE_KEYWORD_MAX || seen.has(key)) continue;
    seen.add(key);
    words.push(word);
  }
  return words;
}
