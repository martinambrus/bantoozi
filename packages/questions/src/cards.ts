import { CARD_LIMITS, type CardTextMode } from '@bantoozi/shared';
import { canonicalSha256 } from '@bantoozi/shared/server';

import { choice, noul, type OptionCriteria } from './builders.js';
import { OTHER_TOPIC_ID, TAXONOMY, taxonomyL1 } from './taxonomy.js';
import type { ChoiceQuestion, NoulQuestion, Question } from './types.js';

/**
 * Call B question builders (spec 05 §4, §5.1–§5.2): one absolute yes/no question per interest card
 * or label, and one level-2 topic Choice per selected branch. A card's built question is part of
 * its answer's cache identity (`card_input_sha256`), so any change here must bump `match-v1`.
 */

/** A card's `body` (spec 05 §5.1). For a label, `interest` is the label definition. */
export interface CardBody {
  interest: string;
  not_for?: string | null | undefined;
  interest_en?: string | null | undefined;
  not_for_en?: string | null | undefined;
  examples_yes?: readonly string[] | null | undefined;
  examples_no?: readonly string[] | null | undefined;
}

/** What the label builder reads: the shared card's title (part of the label's text hash) and body. */
export interface LabelCard {
  title: string;
  body: CardBody;
}

const FOCUS = "Judge the article's main subject, not passing mentions.";
const FALSE_WHAT = 'Only mentions it in passing, or falls under `not_for`';

/**
 * The interest/exclusion pair the model sees: in `english` mode the translated pair when it is
 * complete (a translated interest, and a translated exclusion whenever the card has one), otherwise
 * the pair as written. A translated interest is never mixed with an untranslated `not_for`.
 */
export function effectiveCardText(
  card: CardBody,
  mode: CardTextMode,
): { interest: string; notFor: string | null; translated: boolean } {
  const translated =
    mode === 'english' && !!card.interest_en && (!card.not_for || !!card.not_for_en);
  const interest = translated ? (card.interest_en ?? card.interest) : card.interest;
  const notFor = translated ? card.not_for_en : card.not_for;
  return { interest, notFor: notFor ? notFor : null, translated };
}

function sides(card: CardBody, trueWhat: string) {
  const yes = card.examples_yes ?? [];
  const no = card.examples_no ?? [];
  return {
    true: { what: trueWhat, ...(yes.length > 0 ? { examples: yes } : {}) },
    false: { what: FALSE_WHAT, ...(no.length > 0 ? { examples: no } : {}) },
  };
}

/**
 * The Noul question of an interest card (spec 05 §5.2). Anti-interest cards (`strength = 'never'`)
 * use it unchanged; the ranker inverts their meaning. Examples stay as written in every mode.
 */
export function cardQuestion(card: CardBody, mode: CardTextMode): NoulQuestion {
  const { interest, notFor } = effectiveCardText(card, mode);
  return noul(
    {
      question: 'Would a reader with this interest want to read `article`?',
      interest,
      ...(notFor ? { not_for: notFor } : {}),
      focus: FOCUS,
    },
    sides(card, "The article's main subject falls within `interest`"),
  );
}

/**
 * The Noul question of a label (spec 05 §5.2): the card question's shape with the shared card's
 * title as `label` and its interest as `definition`. `user_labels.name` is display-only and never
 * sent; the label title is semantic text and stays as written in every mode.
 */
export function labelQuestion(card: LabelCard, mode: CardTextMode): NoulQuestion {
  const { interest, notFor } = effectiveCardText(card.body, mode);
  return noul(
    {
      question: 'Does `article` fit this label?',
      label: card.title,
      definition: interest,
      ...(notFor ? { not_for: notFor } : {}),
      focus: FOCUS,
    },
    sides(card.body, "The article's main subject falls within `definition`"),
  );
}

/** `card_input_sha256 = sha256(canonicalJson(actualBuiltQuestion))` (spec 05 §2). */
export function cardInputSha256(question: Question): string {
  return canonicalSha256(question);
}

const CARD_ID = /^[1-9][0-9]{0,18}$/;
const CARD_KEY = /^c([1-9][0-9]{0,18})$/;
const L2_KEY_PREFIX = 't2_';

/** The question key of a card or label: `c<cardId>` (spec 05 §5.2). */
export function cardKey(cardId: string): string {
  if (!CARD_ID.test(cardId)) throw new RangeError(`invalid card id: ${cardId}`);
  return `c${cardId}`;
}

/** The card id of a `c<cardId>` key, or `null` for any other key. */
export function parseCardKey(key: string): string | null {
  return CARD_KEY.exec(key)?.[1] ?? null;
}

/** The question key of a level-2 topic question: `t2_<l1>` (spec 05 §5.2). */
export function l2Key(l1: string): string {
  if (!hasL2Question(l1)) throw new RangeError(`no level-2 question for topic ${l1}`);
  return `${L2_KEY_PREFIX}${l1}`;
}

/** The level-1 id of a `t2_<l1>` key, or `null` for any other key. */
export function parseL2Key(key: string): string | null {
  if (!key.startsWith(L2_KEY_PREFIX)) return null;
  const l1 = key.slice(L2_KEY_PREFIX.length);
  return hasL2Question(l1) ? l1 : null;
}

function hasL2Question(l1: string): boolean {
  return (taxonomyL1(l1)?.children.length ?? 0) > 0;
}

/** The option of a level-2 answer that means no listed subtopic fits. */
export const L2_NONE_OPTION = 'none_of_these';

/** The minimal topic shape the level-2 builder reads (a taxonomy entry or the template placeholder). */
export interface L2Branch {
  nameEn: string;
  children: readonly { id: string; nameEn: string }[];
}

/** The level-2 Choice of a branch (spec 05 §4): one option per child (`<l2>`) plus `none_of_these`. */
export function buildL2Question(branch: L2Branch): ChoiceQuestion {
  const options: Record<string, OptionCriteria> = {};
  for (const child of branch.children) {
    const short = child.id.split('.')[1];
    if (short === undefined || short === '') throw new RangeError(`invalid L2 id: ${child.id}`);
    options[short] = { what: child.nameEn };
  }
  options[L2_NONE_OPTION] = null;
  return choice(
    { question: `Which ${branch.nameEn} subtopic is \`article\` primarily about?` },
    options,
  );
}

/** The level-2 Choice of a level-1 topic of the taxonomy (never `other`, which has no children). */
export function l2Question(l1Id: string): ChoiceQuestion {
  const topic = taxonomyL1(l1Id);
  if (topic === undefined || topic.children.length === 0) {
    throw new RangeError(`no level-2 question for topic ${l1Id}`);
  }
  return buildL2Question(topic);
}

/** Minimum `P(L1)` of a branch that gets a level-2 question (spec 05 §4). */
export const L2_BRANCH_MIN_P = 0.15;
/** At most this many branches per article (spec 05 §4). */
export const L2_MAX_BRANCHES = 2;

/**
 * The level-1 branches that get a level-2 question (spec 05 §4): among the top two level-1 topics
 * (excluding `other`), those with `p ≥ 0.15`, ordered by probability descending, then id. The input
 * is the `topic_l1` Choice probabilities keyed by plain level-1 id; unknown ids are ignored. Zero
 * selected branches is a complete, empty result.
 */
export function selectL2Branches(t1: Readonly<Record<string, number>>): string[] {
  return TAXONOMY.filter((topic) => topic.id !== OTHER_TOPIC_ID && topic.children.length > 0)
    .map((topic) => ({ id: topic.id, p: t1[topic.id] }))
    .filter((entry): entry is { id: string; p: number } => Number.isFinite(entry.p))
    .sort((a, b) => b.p - a.p || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, L2_MAX_BRANCHES)
    .filter((entry) => entry.p >= L2_BRANCH_MIN_P)
    .map((entry) => entry.id);
}

// ── Card body validation (spec 05 §5.1) ─────────────────────────────────────────────────────────

/** Card text limits in code points (spec 05 §5.1), defined in `@bantoozi/shared`. */
export { CARD_LIMITS };

const BODY_KEYS = new Set([
  'interest',
  'not_for',
  'interest_en',
  'not_for_en',
  'examples_yes',
  'examples_no',
]);

export interface CardValidationProblem {
  /** The offending field (`interest`, `examples_yes[2]`, …; `body` for the whole value). */
  path: string;
  message: string;
}

export type CardValidation =
  { ok: true; body: CardBody } | { ok: false; problems: CardValidationProblem[] };

function length(text: string): number {
  return Array.from(text).length;
}

function checkText(
  problems: CardValidationProblem[],
  path: string,
  value: unknown,
  min: number,
  max: number,
): void {
  if (typeof value !== 'string') {
    problems.push({ path, message: 'must be a string' });
    return;
  }
  const size = length(value.trim());
  if (size < min) problems.push({ path, message: `must have at least ${min} characters` });
  if (size > max) problems.push({ path, message: `must have at most ${max} characters` });
}

const isAbsent = (value: unknown): boolean => value === null || value === undefined;
const isFilled = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';

/**
 * Validates a card body (spec 05 §5.1): `interest` 3–300 characters, `not_for` ≤ 300, at most five
 * examples per side of ≤ 200 characters each, no unknown keys, translations of ≤ 600, and the
 * derived English pair either absent or complete (a non-blank `interest_en`, and a non-blank `not_for_en` exactly when the card
 * has a `not_for`, as the database's `card_en_pair_state` requires). Lengths are counted in code
 * points of the trimmed text.
 */
export function validateCardBody(body: unknown): CardValidation {
  const problems: CardValidationProblem[] = [];
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, problems: [{ path: 'body', message: 'must be an object' }] };
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!BODY_KEYS.has(key)) problems.push({ path: key, message: 'is not a card body field' });
  }
  checkText(
    problems,
    'interest',
    record['interest'],
    CARD_LIMITS.interestMin,
    CARD_LIMITS.interestMax,
  );
  if (record['not_for'] !== null && record['not_for'] !== undefined) {
    checkText(problems, 'not_for', record['not_for'], 0, CARD_LIMITS.notForMax);
  }
  for (const key of ['interest_en', 'not_for_en'] as const) {
    const value = record[key];
    if (value === null || value === undefined) continue;
    checkText(problems, key, value, 0, CARD_LIMITS.translatedMax);
  }
  for (const side of ['examples_yes', 'examples_no'] as const) {
    const value = record[side];
    if (value === null || value === undefined) continue;
    if (!Array.isArray(value)) {
      problems.push({ path: side, message: 'must be an array of strings' });
      continue;
    }
    if (value.length > CARD_LIMITS.examplesPerSide) {
      problems.push({ path: side, message: `at most ${CARD_LIMITS.examplesPerSide} examples` });
    }
    value.forEach((example: unknown, i) =>
      checkText(problems, `${side}[${i}]`, example, 1, CARD_LIMITS.exampleMax),
    );
  }
  // The derived English pair, exactly as the database's card_en_pair_state judges it.
  if (!isAbsent(record['interest_en']) || !isAbsent(record['not_for_en'])) {
    const complete =
      isFilled(record['interest_en']) &&
      (isFilled(record['not_for'])
        ? isFilled(record['not_for_en'])
        : isAbsent(record['not_for_en']));
    if (!complete) {
      problems.push({
        path: 'interest_en',
        message: 'the English pair needs interest_en, and not_for_en exactly when not_for is set',
      });
    }
  }
  return problems.length === 0
    ? { ok: true, body: record as unknown as CardBody }
    : { ok: false, problems };
}

/** Validates a card title: 1–60 characters of trimmed text (spec 05 §5.1). */
export function validateCardTitle(title: unknown): CardValidationProblem[] {
  const problems: CardValidationProblem[] = [];
  checkText(problems, 'title', title, CARD_LIMITS.titleMin, CARD_LIMITS.titleMax);
  return problems;
}

/** The default title of a card: the first 60 characters of its interest (spec 05 §5.1). */
export function defaultCardTitle(interest: string): string {
  return Array.from(interest.trim()).slice(0, CARD_LIMITS.titleMax).join('').trimEnd();
}
