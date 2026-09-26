import type { JsonObject, JsonValue } from '@bantoozi/shared';

import {
  CHOICE_MAX_OPTIONS,
  CHOICE_MIN_OPTIONS,
  QUESTION_KEY_PATTERN,
  SCORE_MAX_LEVELS,
  SCORE_MIN_LEVELS,
  type ChoiceQuestion,
  type Criteria,
  type NoulQuestion,
  type Question,
  type ScoreQuestion,
} from './types.js';

/**
 * The tiny helpers that produce TypeSafe questions (spec 05 §3.3): `noul`, `choice` and `score`.
 * They copy their inputs into plain JSON (so a built question never aliases a caller's arrays) and
 * enforce the TypeSafe limits at build time: Choice 2..255 options, Score 2..10 levels, non-empty
 * instructions. Question keys (`[a-zA-Z0-9_.-]{1,64}`) are checked where a question record is
 * assembled, with {@link assertQuestionKey} / {@link questionLimitProblems}.
 */

/** Read-only JSON accepted by the builders (arrays of examples may be readonly). */
export type JsonInput =
  string | number | boolean | null | readonly JsonInput[] | { readonly [key: string]: JsonInput };

/**
 * Instructions: a plain question, or an object with a `question` and named context such as `focus`,
 * `interest` or `not_for` (spec 05 §3.3, §5.2).
 */
export type Instructions =
  string | { readonly question: string; readonly [key: string]: JsonInput };

/** Criteria of one option, level or Noul side: `null`, a short string or `{what, examples?, …}`. */
export type OptionCriteria =
  string | null | readonly JsonInput[] | { readonly [key: string]: JsonInput };

function cloneJson(value: JsonInput, path: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError(`non-finite number at ${path}`);
    return value;
  }
  if (Array.isArray(value)) {
    return (value as readonly JsonInput[]).map((item, i) => cloneJson(item, `${path}[${i}]`));
  }
  const out: JsonObject = {};
  for (const [key, item] of Object.entries(value as { readonly [key: string]: JsonInput })) {
    // An optional property left undefined by a conditional spread is simply absent.
    if (item === undefined) continue;
    out[key] = cloneJson(item, `${path}.${key}`);
  }
  return out;
}

function toCriteria(value: OptionCriteria, path: string): Criteria {
  return cloneJson(value, path) as Criteria;
}

function toInstructions(instructions: Instructions): Criteria {
  if (typeof instructions === 'string') {
    if (instructions.trim().length === 0) throw new RangeError('instructions must not be empty');
    return instructions;
  }
  if (typeof instructions.question !== 'string' || instructions.question.trim().length === 0) {
    throw new RangeError('instructions need a non-empty question');
  }
  return toCriteria(instructions, 'instructions');
}

/** A yes/no question; a high probability always means "yes, the named thing" (spec 05 §3.3). */
export function noul(
  instructions: Instructions,
  criteria?: { readonly true?: OptionCriteria; readonly false?: OptionCriteria },
): NoulQuestion {
  const question: NoulQuestion = { type: 'noul', instructions: toInstructions(instructions) };
  if (criteria !== undefined) {
    const sides: { true?: Criteria; false?: Criteria } = {};
    if (criteria.true !== undefined) sides.true = toCriteria(criteria.true, 'criteria.true');
    if (criteria.false !== undefined) sides.false = toCriteria(criteria.false, 'criteria.false');
    question.criteria = sides;
  }
  return question;
}

/** A single choice among 2..255 named options (option order is kept). */
export function choice(
  instructions: Instructions,
  options: Readonly<Record<string, OptionCriteria>>,
): ChoiceQuestion {
  const names = Object.keys(options);
  if (names.length < CHOICE_MIN_OPTIONS || names.length > CHOICE_MAX_OPTIONS) {
    throw new RangeError(
      `a choice needs ${CHOICE_MIN_OPTIONS}..${CHOICE_MAX_OPTIONS} options, got ${names.length}`,
    );
  }
  const criteria: Record<string, Criteria> = {};
  for (const name of names) {
    if (name.length === 0) throw new RangeError('choice option names must not be empty');
    const option = options[name];
    if (option === undefined) throw new RangeError(`choice option ${name} is undefined`);
    criteria[name] = toCriteria(option, `options.${name}`);
  }
  return { type: 'choice', instructions: toInstructions(instructions), criteria };
}

/** An ordinal score over 2..10 levels, lowest first; the answer's `score` is `Σ i·p_i`. */
export function score(
  instructions: Instructions,
  levels: readonly OptionCriteria[],
): ScoreQuestion {
  if (levels.length < SCORE_MIN_LEVELS || levels.length > SCORE_MAX_LEVELS) {
    throw new RangeError(
      `a score needs ${SCORE_MIN_LEVELS}..${SCORE_MAX_LEVELS} levels, got ${levels.length}`,
    );
  }
  return {
    type: 'score',
    instructions: toInstructions(instructions),
    criteria: levels.map((level, i) => toCriteria(level, `levels[${i}]`)),
  };
}

/** Throws unless `key` is a valid question key (`[a-zA-Z0-9_.-]{1,64}`, spec 04 §1). */
export function assertQuestionKey(key: string): void {
  if (!QUESTION_KEY_PATTERN.test(key)) throw new RangeError(`invalid question key: ${key}`);
}

/**
 * Every TypeSafe limit a question record breaks (empty when it is valid): key pattern, non-empty
 * record, instructions, Choice option count and Score level count (spec 04 §2, spec 05 §11).
 */
export function questionLimitProblems(questions: Readonly<Record<string, Question>>): string[] {
  const problems: string[] = [];
  const keys = Object.keys(questions);
  if (keys.length === 0) problems.push('no questions');
  for (const key of keys) {
    if (!QUESTION_KEY_PATTERN.test(key)) problems.push(`${key}: invalid question key`);
    const question = questions[key];
    if (question === undefined) {
      problems.push(`${key}: missing question`);
      continue;
    }
    const instructions = question.instructions;
    if (instructions === null || (typeof instructions === 'string' && instructions.trim() === '')) {
      problems.push(`${key}: empty instructions`);
    }
    if (question.type === 'choice') {
      const count = Object.keys(question.criteria).length;
      if (count < CHOICE_MIN_OPTIONS || count > CHOICE_MAX_OPTIONS) {
        problems.push(
          `${key}: ${count} choice options (allowed ${CHOICE_MIN_OPTIONS}..${CHOICE_MAX_OPTIONS})`,
        );
      }
    } else if (question.type === 'score') {
      const count = question.criteria.length;
      if (count < SCORE_MIN_LEVELS || count > SCORE_MAX_LEVELS) {
        problems.push(
          `${key}: ${count} score levels (allowed ${SCORE_MIN_LEVELS}..${SCORE_MAX_LEVELS})`,
        );
      }
    }
  }
  return problems;
}
