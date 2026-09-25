const COMBINING_MARKS = /\p{M}+/gu;
const NON_ALPHANUMERIC_RUNS = /[^\p{L}\p{N}]+/gu;

/**
 * `normalizeText` (spec 03 §6.1): NFKD, remove combining marks (diacritics), lower-case, replace
 * runs of non-alphanumeric characters (Unicode letters/numbers, not ASCII `\w`) with one space,
 * trim. Used for `title_norm`, trigram similarity, near-duplicate checks and keyword mutes.
 */
export function normalizeText(input: string): string {
  return input
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(NON_ALPHANUMERIC_RUNS, ' ')
    .trim();
}
