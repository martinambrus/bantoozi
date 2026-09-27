import { normCardText } from '@bantoozi/shared/server';

import { CARD_TEXT_LIMITS, type CardTranslationPair, type ExampleSide } from './validation.js';

/**
 * The card `body` (spec 05 §5.1) and the pure edits the lifecycle makes to it. A body is immutable
 * once stored: every edit here produces the text of **another** card row.
 */

/** `interest_cards.body`, read tolerantly (a blank `not_for` and a missing list mean none). */
export interface ParsedCardBody {
  interest: string;
  notFor: string | null;
  interestEn: string | null;
  notForEn: string | null;
  examplesYes: string[];
  examplesNo: string[];
}

/** Examples per side, oldest first (the newest five are kept). */
export interface CardExamples {
  yes: string[];
  no: string[];
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((e): e is string => typeof e === 'string') : [];

export function parseCardBody(raw: unknown): ParsedCardBody {
  const body = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    interest: typeof body['interest'] === 'string' ? body['interest'] : '',
    notFor: text(body['not_for']),
    interestEn: text(body['interest_en']),
    notForEn: text(body['not_for_en']),
    examplesYes: list(body['examples_yes']),
    examplesNo: list(body['examples_no']),
  };
}

/** The stored JSON shape (`not_for` null when absent, both example lists always present). */
export function serializeCardBody(body: ParsedCardBody): Record<string, unknown> {
  return {
    interest: body.interest,
    not_for: body.notFor,
    interest_en: body.interestEn,
    not_for_en: body.notForEn,
    examples_yes: body.examplesYes,
    examples_no: body.examplesNo,
  };
}

/** The body's complete English pair, or `null` when it has none (or only a partial one). */
export function translationOf(body: ParsedCardBody): CardTranslationPair | null {
  if (body.interestEn === null) return null;
  if (body.notFor !== null && body.notForEn === null) return null;
  return { interestEn: body.interestEn, notForEn: body.notFor === null ? null : body.notForEn };
}

/** Whether two texts hash alike (`norm` of interest and `not_for`, spec 05 §5.1). */
export function sameCardText(
  a: { interest: string; notFor: string | null },
  b: { interest: string; notFor: string | null },
): boolean {
  return (
    normCardText(a.interest) === normCardText(b.interest) &&
    normCardText(a.notFor ?? '') === normCardText(b.notFor ?? '')
  );
}

export function examplesOf(body: ParsedCardBody): CardExamples {
  return { yes: [...body.examplesYes], no: [...body.examplesNo] };
}

export function hasExamples(examples: CardExamples): boolean {
  return examples.yes.length > 0 || examples.no.length > 0;
}

/**
 * Add an example as the newest on `side`, keeping the newest five per side (spec 05 §5.1). The same
 * text (by `norm`) moves off the other side. `null` when it is already an example on `side`.
 */
export function withAddedExample(
  examples: CardExamples,
  side: ExampleSide,
  example: string,
): CardExamples | null {
  const key = normCardText(example);
  const same = side === 'yes' ? examples.yes : examples.no;
  if (same.some((e) => normCardText(e) === key)) return null;
  const other = (side === 'yes' ? examples.no : examples.yes).filter(
    (e) => normCardText(e) !== key,
  );
  const next = [...same, example].slice(-CARD_TEXT_LIMITS.examplesPerSide);
  return side === 'yes' ? { yes: next, no: other } : { yes: other, no: next };
}

/**
 * Remove one example from `side`: the exact text, else the first equal under `norm`. `null` when
 * `side` has no such example.
 */
export function withRemovedExample(
  examples: CardExamples,
  side: ExampleSide,
  example: string,
): CardExamples | null {
  const same = side === 'yes' ? examples.yes : examples.no;
  let index = same.indexOf(example);
  if (index < 0) {
    const key = normCardText(example);
    index = same.findIndex((e) => normCardText(e) === key);
  }
  if (index < 0) return null;
  const next = same.filter((_, i) => i !== index);
  return side === 'yes'
    ? { yes: next, no: [...examples.no] }
    : { yes: [...examples.yes], no: next };
}

/** The default title: the first 60 characters of the interest (spec 05 §5.1). */
export function defaultCardTitle(interest: string): string {
  return [...interest.trim()].slice(0, CARD_TEXT_LIMITS.titleMax).join('').trimEnd();
}

/** Differences between two library versions (spec 05 §8 `GET /library/updates`). */
export interface LibraryCardDiff {
  /** Display title change (not semantic for interest cards; shown for review). */
  title: { from: string; to: string } | null;
  /** Semantic `interest` change (`norm` differs). */
  interest: { from: string; to: string } | null;
  /** Semantic `not_for` change (`norm` differs). */
  notFor: { from: string | null; to: string | null } | null;
  examplesYes: { added: string[]; removed: string[] };
  examplesNo: { added: string[]; removed: string[] };
}

function listDiff(from: readonly string[], to: readonly string[]) {
  return {
    added: to.filter((e) => !from.includes(e)),
    removed: from.filter((e) => !to.includes(e)),
  };
}

export function libraryCardDiff(
  from: { title: string; body: ParsedCardBody },
  to: { title: string; body: ParsedCardBody },
): LibraryCardDiff {
  return {
    title: from.title === to.title ? null : { from: from.title, to: to.title },
    interest:
      normCardText(from.body.interest) === normCardText(to.body.interest)
        ? null
        : { from: from.body.interest, to: to.body.interest },
    notFor:
      normCardText(from.body.notFor ?? '') === normCardText(to.body.notFor ?? '')
        ? null
        : { from: from.body.notFor, to: to.body.notFor },
    examplesYes: listDiff(from.body.examplesYes, to.body.examplesYes),
    examplesNo: listDiff(from.body.examplesNo, to.body.examplesNo),
  };
}
