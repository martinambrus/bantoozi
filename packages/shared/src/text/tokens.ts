/**
 * Token estimation (spec 04 §6.1), shared by engine admission (reservations) and question packing
 * (spec 05 §5.2), so both use one estimator and one safety policy.
 *
 * `estimateTokens(state, questions) = ceil(len(JSON.stringify(state)) / 3.5)
 *   + Σ ceil(len(JSON.stringify(q)) / 3.5) + 20`
 *
 * This is a planning heuristic, not a bound for every script. {@link conservativeTokens} is the
 * bound used for admission and packing: the heuristic times {@link TOKEN_SAFETY_FACTOR}, and for
 * text dominated by non-Latin scripts the serialized UTF-8 byte length instead.
 */

/** Characters per token of the §6.1 heuristic. */
export const CHARS_PER_TOKEN = 3.5;
/** Fixed per-request overhead of the §6.1 heuristic. */
export const REQUEST_OVERHEAD_TOKENS = 20;
/**
 * Safety multiplier on the heuristic until provider counts calibrate it (spec 04 §6.1: "apply a
 * safety multiplier learned from the smoke-test fixtures").
 */
export const TOKEN_SAFETY_FACTOR = 1.25;
/** Share of non-Latin letters above which a text is an "unfamiliar script" (byte-length bound). */
export const UNFAMILIAR_SCRIPT_SHARE = 0.2;

const LETTER = /\p{L}/u;
const LATIN = /\p{Script=Latin}/u;
const UTF8 = new TextEncoder();

/** `ceil(len(JSON.stringify(value)) / 3.5)`: the §6.1 heuristic for one serialized value. */
export function heuristicTokens(value: unknown): number {
  return Math.ceil((JSON.stringify(value) ?? '').length / CHARS_PER_TOKEN);
}

/** The §6.1 formula for a request: state + each question + fixed overhead. */
export function estimateTokens(state: unknown, questions: Record<string, unknown>): number {
  let total = heuristicTokens(state) + REQUEST_OVERHEAD_TOKENS;
  for (const q of Object.values(questions)) total += heuristicTokens(q);
  return total;
}

/** Whether a serialized text is dominated by non-Latin letters (Cyrillic, CJK, …). */
export function isUnfamiliarScript(text: string): boolean {
  let letters = 0;
  let nonLatin = 0;
  for (const ch of text) {
    if (!LETTER.test(ch)) continue;
    letters += 1;
    if (!LATIN.test(ch)) nonLatin += 1;
  }
  return letters > 0 && nonLatin / letters > UNFAMILIAR_SCRIPT_SHARE;
}

/**
 * Conservative token bound of one serialized value: the heuristic times the safety factor, or the
 * UTF-8 byte length for unfamiliar scripts (spec 04 §6.1). Used by admission and packing.
 */
export function conservativeTokens(value: unknown): number {
  const text = JSON.stringify(value) ?? '';
  if (isUnfamiliarScript(text)) return UTF8.encode(text).length;
  return Math.ceil((text.length / CHARS_PER_TOKEN) * TOKEN_SAFETY_FACTOR);
}

/** Conservative bound of a whole request (state + questions + overhead). */
export function conservativeRequestTokens(
  state: unknown,
  questions: Record<string, unknown>,
): number {
  let total = conservativeTokens(state) + REQUEST_OVERHEAD_TOKENS;
  for (const q of Object.values(questions)) total += conservativeTokens(q);
  return total;
}
