import type {
  Answer,
  ChoiceAnswer,
  EngineRequest,
  NoulAnswer,
  Question,
  ScoreAnswer,
} from './types.js';

/**
 * Answer normalization and outbound request validation for every engine (spec 04 §2). Pure
 * functions over untrusted JSON: fields are read as own data properties only (never inherited,
 * never through a getter), output maps are built with `Object.fromEntries` (own properties even for
 * a key such as `__proto__`), and any missing, extra or mistyped key makes the whole response
 * invalid. Nothing is clamped or invented: a value outside its bounds rejects the response.
 */

/** Probability distributions must sum to 1 within this tolerance; inside it they are renormalized. */
export const PROBABILITY_SUM_TOLERANCE = 0.02;
/** A reported score must match the recomputed `Σ i·p_i` within this tolerance. */
export const SCORE_MATCH_TOLERANCE = 0.02;
/** Floating-point slack, so a value exactly on a tolerance boundary counts as inside it. */
const BOUNDARY_EPSILON = 1e-9;

/**
 * Question keys (spec 04 §1). Mirrors `QUESTION_KEY_PATTERN` of `@bantoozi/questions`, which this
 * package may import for types only (spec 01 §2); a test keeps the two equal.
 */
export const ENGINE_QUESTION_KEY_PATTERN = /^[a-zA-Z0-9_.-]{1,64}$/;
/** TypeSafe minimums (spec 05 §11): a Choice needs 2 options, a Score 2 levels. */
export const MIN_CHOICE_OPTIONS = 2;
export const MIN_SCORE_LEVELS = 2;

/** Outbound request limits checked before any spend (spec 04 §2). */
export interface RequestLimits {
  /** Questions per request (spec 05 §5.2 packing: `count ≤ 200`). */
  maxQuestions: number;
  /** TypeSafe: at most 255 Choice options. */
  maxChoiceOptions: number;
  /** TypeSafe: at most 10 Score levels. */
  maxScoreLevels: number;
  /** UTF-8 bytes of the serialized `{state, questions}`. */
  maxRequestBytes: number;
}

export const DEFAULT_REQUEST_LIMITS: Readonly<RequestLimits> = Object.freeze({
  maxQuestions: 200,
  maxChoiceOptions: 255,
  maxScoreLevels: 10,
  maxRequestBytes: 1024 * 1024,
});

/** A JSON value deeper than this is rejected (a builder bug or a cycle, never a real state). */
const MAX_JSON_DEPTH = 64;
/** Only these fields may appear on an outbound question object. */
const QUESTION_FIELDS = new Set(['type', 'instructions', 'criteria']);
const NOUL_CRITERIA_FIELDS = new Set(['true', 'false']);
/** Assigning this key to a plain object changes its prototype instead of adding a property. */
const PROTO_KEY = '__proto__';

export type RequestValidation =
  | { ok: true; bytes: number; questionCount: number }
  /** `detail` is log-safe: it names our own question keys, never state or criteria text. */
  | { ok: false; detail: string };

export type AnswerFormat =
  /** Jev's `systemone` answers (TypeSafe, and later the Jev-compatible Laya port). */
  | 'jev'
  /** The closed JSON schema the LLM fallback answers in (spec 04 §8, `buildLlmSchema`). */
  | 'llm';

export type NormalizeResult =
  | { ok: true; answers: Record<string, Answer> }
  /** `detail` is log-safe: it never echoes an unexpected key or a string value of the response. */
  | { ok: false; detail: string };

type Step<T> = { ok: true; value: T } | { ok: false; detail: string };

const pass = <T>(value: T): Step<T> => ({ ok: true, value });
const reject = (detail: string): { ok: false; detail: string } => ({ ok: false, detail });

/** A plain JSON-like object: not null, not an array, not a class instance. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** An own data property's value; inherited properties and accessors read as undefined. */
function ownValue(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

function hasOwnData(record: object, key: string): boolean {
  return ownValue(record, key) !== undefined;
}

/** Rounds for log details only. */
const shown = (value: number): string => String(Math.round(value * 10_000) / 10_000);

/** Caps a caller-supplied key (an option or question key of our own request) for log details. */
const shownKey = (key: string): string => (key.length > 64 ? `${key.slice(0, 61)}...` : key);

/** Why `value` is not a finite, plain JSON value, or undefined when it is one. */
function jsonProblem(value: unknown, depth: number): string | undefined {
  if (value === null) return undefined;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return undefined;
    case 'number':
      return Number.isFinite(value) ? undefined : 'a non-finite number';
    case 'object': {
      if (depth >= MAX_JSON_DEPTH) return 'nesting deeper than 64 levels';
      if (Array.isArray(value)) {
        // An array hole or undefined item would silently serialize as null.
        for (let i = 0; i < value.length; i += 1) {
          if (!Object.hasOwn(value, i)) return 'an array hole';
          const problem = jsonProblem(ownValue(value, String(i)), depth + 1);
          if (problem !== undefined) return problem;
        }
        return undefined;
      }
      if (!isPlainObject(value)) return 'a non-plain object';
      for (const key of Object.keys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !('value' in descriptor)) return 'an accessor property';
        // Undefined properties are omitted by JSON.stringify and canonicalJson alike.
        if (descriptor.value === undefined) continue;
        const problem = jsonProblem(descriptor.value, depth + 1);
        if (problem !== undefined) return problem;
      }
      return undefined;
    }
    case 'undefined':
      return 'an undefined value';
    default:
      return `a ${typeof value}`;
  }
}

/** TypeSafe "EntryType": a string, JSON object, JSON array or null (never a bare number). */
function criteriaProblem(value: unknown): string | undefined {
  if (value === undefined) return 'missing';
  if (typeof value === 'number' || typeof value === 'boolean') return `a bare ${typeof value}`;
  return jsonProblem(value, 1);
}

function questionProblem(question: unknown, limits: RequestLimits): string | undefined {
  if (!isPlainObject(question)) return 'not an object';
  for (const field of Object.keys(question)) {
    if (!QUESTION_FIELDS.has(field)) return 'an unexpected field';
  }
  const type = ownValue(question, 'type');
  if (type !== 'noul' && type !== 'choice' && type !== 'score') return 'an unknown type';
  const instructions = criteriaProblem(ownValue(question, 'instructions'));
  if (instructions !== undefined) return `instructions: ${instructions}`;
  const criteria = ownValue(question, 'criteria');

  if (type === 'noul') {
    if (criteria === undefined) return undefined;
    if (!isPlainObject(criteria)) return 'criteria is not an object';
    for (const key of Object.keys(criteria)) {
      if (!NOUL_CRITERIA_FIELDS.has(key)) return 'criteria has a key other than true/false';
      const value = ownValue(criteria, key);
      if (value === undefined) continue;
      const problem = criteriaProblem(value);
      if (problem !== undefined) return `criteria.${key}: ${problem}`;
    }
    return undefined;
  }

  if (type === 'choice') {
    if (!isPlainObject(criteria)) return 'criteria is not an object';
    const options = Object.keys(criteria);
    if (options.length < MIN_CHOICE_OPTIONS || options.length > limits.maxChoiceOptions) {
      return `${options.length} options (allowed ${MIN_CHOICE_OPTIONS}..${limits.maxChoiceOptions})`;
    }
    for (const option of options) {
      if (option === '' || option === PROTO_KEY) return 'an invalid option key';
      const problem = criteriaProblem(ownValue(criteria, option));
      if (problem !== undefined) return `option ${shownKey(option)}: ${problem}`;
    }
    return undefined;
  }

  if (!Array.isArray(criteria)) return 'criteria is not an array';
  if (criteria.length < MIN_SCORE_LEVELS || criteria.length > limits.maxScoreLevels) {
    return `${criteria.length} levels (allowed ${MIN_SCORE_LEVELS}..${limits.maxScoreLevels})`;
  }
  for (let level = 0; level < criteria.length; level += 1) {
    const problem = criteriaProblem(
      Object.hasOwn(criteria, level) ? ownValue(criteria, String(level)) : undefined,
    );
    if (problem !== undefined) return `level ${level}: ${problem}`;
  }
  return undefined;
}

/**
 * Validates an outbound request before any spend (spec 04 §2): question keys, question shapes,
 * a nonempty set within `maxQuestions`, option/level counts, a finite plain-JSON state and the
 * serialized byte size. Engines call it again before their wire attempt; a failure is
 * `invalid_request`, which is never retried or routed to another provider.
 */
export function validateRequest(
  req: Pick<EngineRequest, 'state' | 'questions'>,
  limits: Partial<RequestLimits> = {},
): RequestValidation {
  const effective: RequestLimits = { ...DEFAULT_REQUEST_LIMITS, ...limits };
  const { questions } = req;
  if (!isPlainObject(questions)) return reject('questions: not an object');
  const keys = Object.keys(questions);
  if (keys.length === 0) return reject('questions: empty');
  if (keys.length > effective.maxQuestions) {
    return reject(`questions: ${keys.length} exceed the limit of ${effective.maxQuestions}`);
  }
  for (const key of keys) {
    if (!ENGINE_QUESTION_KEY_PATTERN.test(key) || key === PROTO_KEY) {
      return reject('questions: an invalid key');
    }
    const problem = questionProblem(ownValue(questions, key), effective);
    if (problem !== undefined) return reject(`questions.${key}: ${problem}`);
  }
  const stateProblem = req.state === undefined ? 'missing' : jsonProblem(req.state, 0);
  if (stateProblem !== undefined) return reject(`state: ${stateProblem}`);
  const bytes = Buffer.byteLength(JSON.stringify({ state: req.state, questions }), 'utf8');
  if (bytes > effective.maxRequestBytes) {
    return reject(`request: ${bytes} bytes exceed the limit of ${effective.maxRequestBytes}`);
  }
  return { ok: true, bytes, questionCount: keys.length };
}

/**
 * `1 − H(p) / ln(k)` with `0·ln(0) = 0` (spec 04 §2): 0 for a uniform distribution, 1 for a
 * certain one. `probabilities` must already be a distribution over all `k` options/levels. This is
 * our proxy for engines that report no confidence, not a probability of being correct.
 */
export function entropyConfidence(probabilities: readonly number[]): number {
  const k = probabilities.length;
  if (k < 2) return 1;
  let entropy = 0;
  for (const p of probabilities) {
    if (p > 0) entropy -= p * Math.log(p);
  }
  const confidence = 1 - entropy / Math.log(k);
  return Math.min(1, Math.max(0, confidence));
}

/** A finite number in [0, 1], or undefined. */
function probability(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

interface Distribution {
  /** Renormalized to sum to exactly 1 (up to floating point). */
  probabilities: number[];
  /** As received, for the score-consistency check. */
  raw: number[];
}

/**
 * A probability object with exactly `keys` (in that order), each value in [0, 1], summing to
 * 1 ± 0.02 (spec 04 §2). A zero-sum object is outside the tolerance, so it is rejected too.
 */
function distribution(value: unknown, keys: readonly string[]): Step<Distribution> {
  if (!isPlainObject(value)) return reject('probabilities: not an object');
  const raw: number[] = [];
  for (const key of keys) {
    if (!hasOwnData(value, key)) return reject(`probabilities: missing ${shownKey(key)}`);
    const p = probability(ownValue(value, key));
    if (p === undefined) {
      return reject(`probabilities.${shownKey(key)}: not a finite number in [0, 1]`);
    }
    raw.push(p);
  }
  // Every expected key is present, so any further own key is an extra one.
  if (Object.keys(value).length !== keys.length) return reject('probabilities: unexpected keys');
  const sum = raw.reduce((total, p) => total + p, 0);
  if (!(Math.abs(sum - 1) <= PROBABILITY_SUM_TOLERANCE + BOUNDARY_EPSILON)) {
    return reject(`probabilities: sum ${shown(sum)} is outside 1 ± ${PROBABILITY_SUM_TOLERANCE}`);
  }
  return pass({ probabilities: raw.map((p) => p / sum), raw });
}

/** `Σ i·p_i`: the expected level of a score distribution. */
function expectedLevel(probabilities: readonly number[]): number {
  return probabilities.reduce((total, p, level) => total + level * p, 0);
}

/** Index of the largest probability; ties go to the first one (the request's option order). */
function argmax(probabilities: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < probabilities.length; i += 1) {
    if ((probabilities[i] ?? 0) > (probabilities[best] ?? 0)) best = i;
  }
  return best;
}

const levelKeys = (levels: number): string[] => Array.from({ length: levels }, (_, i) => String(i));

/** Confidence reported by the engine when present (Jev), otherwise the entropy proxy. */
function reportedConfidence(value: unknown, probabilities: readonly number[]): Step<number> {
  if (value === undefined || value === null) return pass(entropyConfidence(probabilities));
  const confidence = probability(value);
  return confidence === undefined
    ? reject('confidence: not a finite number in [0, 1]')
    : pass(confidence);
}

function choiceAnswer(
  options: readonly string[],
  dist: Distribution,
  confidence: number,
): ChoiceAnswer {
  return {
    type: 'choice',
    choice: options[argmax(dist.probabilities)] ?? '',
    probabilities: Object.fromEntries(
      options.map((option, i): [string, number] => [option, dist.probabilities[i] ?? 0]),
    ),
    confidence,
  };
}

function scoreAnswer(dist: Distribution, confidence: number): ScoreAnswer {
  return {
    type: 'score',
    score: expectedLevel(dist.probabilities),
    probabilities: dist.probabilities,
    confidence,
    levels: dist.probabilities.length,
  };
}

/** Names a received `type` without echoing an arbitrary string. */
function typeLabel(value: unknown): string {
  if (value === 'noul' || value === 'choice' || value === 'score') return value;
  return value === undefined ? 'no type' : `a ${typeof value} type`;
}

/** One Jev answer: `{type, noul}` / `{type, choice?, probabilities, confidence?}` / `{type, score, probabilities, confidence?, legend?}`. */
function normalizeJevAnswer(value: unknown, question: Question): Step<Answer> {
  if (!isPlainObject(value)) return reject('not an object');
  const type = ownValue(value, 'type');
  if (type !== question.type) return reject(`${typeLabel(type)} for a ${question.type} question`);

  if (question.type === 'noul') {
    const p = probability(ownValue(value, 'noul'));
    if (p === undefined) return reject('noul: not a finite number in [0, 1]');
    const answer: NoulAnswer = { type: 'noul', p };
    return pass(answer);
  }

  if (question.type === 'choice') {
    const options = Object.keys(question.criteria);
    const dist = distribution(ownValue(value, 'probabilities'), options);
    if (!dist.ok) return dist;
    const choice = ownValue(value, 'choice');
    if (choice !== undefined && (typeof choice !== 'string' || !options.includes(choice))) {
      return reject('choice: not one of the options');
    }
    const confidence = reportedConfidence(ownValue(value, 'confidence'), dist.value.probabilities);
    if (!confidence.ok) return confidence;
    return pass(choiceAnswer(options, dist.value, confidence.value));
  }

  const dist = distribution(ownValue(value, 'probabilities'), levelKeys(question.criteria.length));
  if (!dist.ok) return dist;
  const reported = ownValue(value, 'score');
  if (typeof reported !== 'number' || !Number.isFinite(reported)) {
    return reject('score: not a finite number');
  }
  // The engine may have computed its score before or after rounding/normalizing what it sent;
  // either is a consistent answer. A larger gap means the levels or the score are garbled.
  const recomputed = expectedLevel(dist.value.probabilities);
  const gap = Math.min(
    Math.abs(reported - recomputed),
    Math.abs(reported - expectedLevel(dist.value.raw)),
  );
  if (gap > SCORE_MATCH_TOLERANCE + BOUNDARY_EPSILON) {
    return reject(`score: ${shown(reported)} does not match Σ i·p_i = ${shown(recomputed)}`);
  }
  const confidence = reportedConfidence(ownValue(value, 'confidence'), dist.value.probabilities);
  if (!confidence.ok) return confidence;
  return pass(scoreAnswer(dist.value, confidence.value));
}

/** One LLM answer: exactly `{p}` (noul) or exactly `{probabilities}` (choice and score). */
function normalizeLlmAnswer(value: unknown, question: Question): Step<Answer> {
  if (!isPlainObject(value)) return reject('not an object');
  const field = question.type === 'noul' ? 'p' : 'probabilities';
  if (!hasOwnData(value, field)) return reject(`missing ${field}`);
  if (Object.keys(value).length !== 1) return reject('unexpected fields');

  if (question.type === 'noul') {
    const p = probability(ownValue(value, 'p'));
    if (p === undefined) return reject('p: not a finite number in [0, 1]');
    const answer: NoulAnswer = { type: 'noul', p };
    return pass(answer);
  }
  if (question.type === 'choice') {
    const options = Object.keys(question.criteria);
    const dist = distribution(ownValue(value, 'probabilities'), options);
    if (!dist.ok) return dist;
    return pass(choiceAnswer(options, dist.value, entropyConfidence(dist.value.probabilities)));
  }
  const dist = distribution(ownValue(value, 'probabilities'), levelKeys(question.criteria.length));
  if (!dist.ok) return dist;
  return pass(scoreAnswer(dist.value, entropyConfidence(dist.value.probabilities)));
}

/**
 * Normalizes an engine's raw answers into the `Answer` union (spec 04 §2). Exactly the requested
 * keys with the requested types must be present; missing, extra or mistyped keys, out-of-range or
 * non-finite values and distributions outside `1 ± 0.02` make the whole response invalid.
 * Distributions inside the tolerance are renormalized; `choice` is the argmax (ties: the request's
 * option order); score probabilities become an array over levels `0..n−1` and `score = Σ i·p_i`
 * is recomputed (and, for Jev, must match the reported score within 0.02); `confidence` is the
 * engine's own (Jev) or {@link entropyConfidence}.
 *
 * `raw` is untrusted parsed JSON: the `answers` object of a Jev response, or the whole JSON the LLM
 * returned. `questions` is the request's own (trusted) question set.
 */
export function normalizeAnswers(
  raw: unknown,
  questions: Record<string, Question>,
  options: { format?: AnswerFormat } = {},
): NormalizeResult {
  const format = options.format ?? 'jev';
  if (!isPlainObject(raw)) return reject('answers: not an object');
  const keys = Object.keys(questions);
  for (const key of keys) {
    if (!hasOwnData(raw, key)) return reject(`answers: missing ${key}`);
  }
  const extra = Object.keys(raw).length - keys.length;
  if (extra > 0) return reject(`answers: ${extra} unexpected key${extra === 1 ? '' : 's'}`);

  const entries: Array<[string, Answer]> = [];
  for (const key of keys) {
    const question = ownValue(questions, key) as Question;
    const value = ownValue(raw, key);
    const step =
      format === 'jev' ? normalizeJevAnswer(value, question) : normalizeLlmAnswer(value, question);
    if (!step.ok) return reject(`answers.${key}: ${step.detail}`);
    entries.push([key, step.value]);
  }
  return { ok: true, answers: Object.fromEntries(entries) };
}
