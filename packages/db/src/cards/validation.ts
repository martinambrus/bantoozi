import { AppError, isBigIntString } from '@bantoozi/shared';

/**
 * Card and label input validation (spec 05 §5.1, spec 08 §7). The API validates request shapes with
 * zod first; the repository validates again because it is the last writer of immutable card text.
 * Text is trimmed, and lengths count Unicode code points (never more than the UTF-16 length a zod
 * `.max()` sees, so anything the API accepts passes here too).
 */

/** Text limits of spec 05 §5.1 (label names use the title limit; definitions the interest limits). */
export const CARD_TEXT_LIMITS = {
  titleMax: 60,
  interestMin: 3,
  interestMax: 300,
  notForMax: 300,
  examplesPerSide: 5,
  exampleMax: 200,
  /** A caller-supplied English pair (spec 07 §5); twice the source limit allows for expansion. */
  translationMax: 600,
} as const;

export const CARD_STRENGTHS = ['must', 'love', 'like', 'never'] as const;
export type CardStrength = (typeof CARD_STRENGTHS)[number];

export const EXAMPLE_SIDES = ['yes', 'no'] as const;
export type ExampleSide = (typeof EXAMPLE_SIDES)[number];

/** Label colours are `#rrggbb` values, never arbitrary CSS (spec 08 §7); stored lower-case. */
export const LABEL_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

/** The colour of a label created without one (slate), so every stored colour is hex (D-42). */
export const DEFAULT_LABEL_COLOR = '#64748b';

/** `interest_cards.lang`: an ISO 639-1 code or `und` (spec 03 §8.3, spec 07 §5). */
export const CARD_LANG_PATTERN = /^(?:[a-z]{2}|und)$/;

/** The language a new card row gets when the caller detected none. */
export const UNKNOWN_CARD_LANG = 'und';

/**
 * The derived English pair the API may supply for a non-English card under
 * `card_text_mode = 'english'` (spec 05 §5.1, spec 07 §5): complete or absent, never partial.
 */
export interface CardTranslationPair {
  interestEn: string;
  /** Present exactly when the card has a `not_for`. */
  notForEn: string | null;
}

/** `400 VALIDATION_FAILED` naming the field and a machine-readable reason (no input echoed). */
export function invalidField(field: string, reason: string): AppError {
  return new AppError('VALIDATION_FAILED', `Invalid ${field}`, { details: { field, reason } });
}

/** Code points, so a surrogate pair counts as one character. */
export function codePointLength(value: string): number {
  return [...value].length;
}

/**
 * Control characters (other than tab and line breaks) and unpaired surrogates: PostgreSQL `jsonb`
 * cannot store `\u0000` or a lone surrogate, and neither belongs in card text.
 */
function hasForbiddenCharacter(value: string): boolean {
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x7f || (cp >= 0xd800 && cp <= 0xdfff)) return true;
    if (cp < 0x20 && ch !== '\t' && ch !== '\n' && ch !== '\r') return true;
  }
  return false;
}

function boundedText(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string') throw invalidField(field, 'type');
  const trimmed = value.trim();
  if (hasForbiddenCharacter(trimmed)) throw invalidField(field, 'characters');
  const length = codePointLength(trimmed);
  if (length === 0) throw invalidField(field, 'required');
  if (length < min) throw invalidField(field, 'too_short');
  if (length > max) throw invalidField(field, 'too_long');
  return trimmed;
}

/** A card title or label name: 1–60 characters. */
export function validateCardTitle(value: unknown, field = 'title'): string {
  return boundedText(value, field, 1, CARD_TEXT_LIMITS.titleMax);
}

/** A card interest or label definition: 3–300 characters. */
export function validateCardInterest(value: unknown, field = 'interest'): string {
  return boundedText(value, field, CARD_TEXT_LIMITS.interestMin, CARD_TEXT_LIMITS.interestMax);
}

/** `not_for`: at most 300 characters; absent, null or blank means none. */
export function validateCardNotFor(value: unknown, field = 'notFor'): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  return boundedText(value, field, 1, CARD_TEXT_LIMITS.notForMax);
}

/** One example text: 1–200 characters. */
export function validateCardExample(value: unknown, field = 'text'): string {
  return boundedText(value, field, 1, CARD_TEXT_LIMITS.exampleMax);
}

export function validateCardStrength(value: unknown): CardStrength {
  if (typeof value === 'string' && (CARD_STRENGTHS as readonly string[]).includes(value)) {
    return value as CardStrength;
  }
  throw invalidField('strength', 'enum');
}

export function validateExampleSide(value: unknown): ExampleSide {
  if (value === 'yes' || value === 'no') return value;
  throw invalidField('side', 'enum');
}

/** A positive bigint id as a decimal string (spec 01 §5). */
export function validateId(value: unknown, field: string): string {
  // Not `IdSchema.safeParse`: its chained refinements also run on a non-decimal string, where
  // `BigInt()` throws a SyntaxError instead of failing validation.
  if (typeof value === 'string' && isBigIntString(value) && BigInt(value) > 0n) return value;
  throw invalidField(field, 'id');
}

/** A card scope: one subscribed feed, or `null` for all feeds. */
export function validateScopeFeedId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return validateId(value, 'scopeFeedId');
}

/** A detected card language; unknown when the caller detected none. */
export function validateCardLang(value: unknown): string {
  if (value === undefined) return UNKNOWN_CARD_LANG;
  if (typeof value === 'string' && CARD_LANG_PATTERN.test(value)) return value;
  throw invalidField('lang', 'language');
}

/**
 * A complete English pair for a non-English card, validated against the card's own `not_for`:
 * `notForEn` is required exactly when the card has a `not_for` (the `card_en_pair_state` rule).
 */
export function validateCardTranslation(
  value: CardTranslationPair | null | undefined,
  notFor: string | null,
  lang: string,
): CardTranslationPair | null {
  if (value === undefined || value === null) return null;
  if (lang === 'en' || lang === UNKNOWN_CARD_LANG) throw invalidField('translation', 'language');
  const interestEn = boundedText(
    value.interestEn,
    'translation.interestEn',
    1,
    CARD_TEXT_LIMITS.translationMax,
  );
  if (notFor === null) {
    const extra: unknown = value.notForEn;
    if (
      extra !== null &&
      extra !== undefined &&
      !(typeof extra === 'string' && extra.trim() === '')
    ) {
      throw invalidField('translation.notForEn', 'unexpected');
    }
    return { interestEn, notForEn: null };
  }
  const notForEn = boundedText(
    value.notForEn,
    'translation.notForEn',
    1,
    CARD_TEXT_LIMITS.translationMax,
  );
  return { interestEn, notForEn };
}

export function validateLabelColor(value: unknown): string {
  if (typeof value === 'string' && LABEL_COLOR_PATTERN.test(value)) return value.toLowerCase();
  throw invalidField('color', 'color');
}

/**
 * The example an article contributes: its title with whitespace collapsed, cut to 200 characters
 * (spec 05 §5.1, spec 08 §7); `null` when nothing usable remains.
 */
export function exampleFromArticleTitle(title: string): string | null {
  let visible = '';
  for (const ch of title) {
    // Whitespace controls collapse below; other controls and lone surrogates are dropped.
    if (!/\s/u.test(ch) && hasForbiddenCharacter(ch)) continue;
    visible += ch;
  }
  const collapsed = visible.replace(/\s+/gu, ' ').trim();
  const cut = [...collapsed].slice(0, CARD_TEXT_LIMITS.exampleMax).join('').trim();
  return cut === '' ? null : cut;
}
