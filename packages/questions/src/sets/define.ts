import { canonicalSha256 } from '@bantoozi/shared/server';

import { assertQuestionKey } from '../builders.js';
import type { Question } from '../types.js';

/** Question-set kinds (`question_sets.kind`, spec 02 §3.1). */
export type QuestionSetKind = 'enrich' | 'match' | 'cluster' | 'suggest';

export const QUESTION_SET_KINDS: readonly QuestionSetKind[] = [
  'enrich',
  'match',
  'cluster',
  'suggest',
];

/** A `question_sets` row as the code defines it (spec 05 §2). */
export interface QuestionSetDefinition {
  readonly kind: QuestionSetKind;
  /** Never reused for new wording (`enrich-v2`, …). */
  readonly version: string;
  /**
   * The stored `definition`: `{kind, version, questions}` of a static set, the builder template
   * (the builders applied to fixed placeholder inputs) of a dynamic set.
   */
  readonly definition: {
    readonly kind: QuestionSetKind;
    readonly version: string;
    readonly [part: string]: unknown;
  };
  /** `sha256(canonicalJson(definition))`, the set's `question_set_sha`. */
  readonly sha256: string;
}

/** A static set also exposes its questions, which every call sends unchanged. */
export interface StaticQuestionSet<
  K extends QuestionSetKind = QuestionSetKind,
  Q extends Readonly<Record<string, Question>> = Readonly<Record<string, Question>>,
> extends QuestionSetDefinition {
  readonly kind: K;
  readonly questions: Q;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

/**
 * A static set `{kind, version, questions}` (spec 05 §2): its definition is exactly that object and
 * its sha is `sha256(canonicalJson({kind, version, questions}))`. The result is deeply frozen, so a
 * handler cannot change what is sent without changing the hash.
 */
export function staticQuestionSet<
  K extends QuestionSetKind,
  Q extends Readonly<Record<string, Question>>,
>(set: { kind: K; version: string; questions: Q }): StaticQuestionSet<K, Q> {
  for (const key of Object.keys(set.questions)) assertQuestionKey(key);
  const definition = { kind: set.kind, version: set.version, questions: set.questions };
  return deepFreeze({
    kind: set.kind,
    version: set.version,
    questions: set.questions,
    definition,
    sha256: canonicalSha256(definition),
  });
}

/** A dynamic set, hashed over its template (spec 05 §2); the questions are built per call. */
export function dynamicQuestionSet(definition: {
  kind: QuestionSetKind;
  version: string;
  [part: string]: unknown;
}): QuestionSetDefinition {
  return deepFreeze({
    kind: definition.kind,
    version: definition.version,
    definition,
    sha256: canonicalSha256(definition),
  });
}
