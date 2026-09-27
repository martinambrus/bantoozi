import type { JsonArray, JsonObject } from '@bantoozi/shared';

/**
 * Question and answer shapes of the decision engine (spec 04 §1). They live here, in the pure
 * question package, because the builders produce them and `packages/engine` may import
 * `packages/questions` for types only (spec 01 §2); `packages/engine` re-exports them from its
 * `types.ts` under the same names.
 */

/** TypeSafe "EntryType": instructions and criteria are strings, JSON objects/arrays or null. */
export type Criteria = string | JsonObject | JsonArray | null;

export interface NoulQuestion {
  type: 'noul';
  instructions: Criteria;
  criteria?: { true?: Criteria; false?: Criteria };
}

/** 2..255 options. */
export interface ChoiceQuestion {
  type: 'choice';
  instructions: Criteria;
  criteria: Record<string, Criteria>;
}

/** 2..10 levels. */
export interface ScoreQuestion {
  type: 'score';
  instructions: Criteria;
  criteria: Criteria[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: 'noul';
  p: number;
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: 'score';
  score: number;
  probabilities: number[];
  confidence: number;
  levels: number;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/** Question keys: `[a-zA-Z0-9_.-]{1,64}` (spec 04 §1). */
export const QUESTION_KEY_PATTERN = /^[a-zA-Z0-9_.-]{1,64}$/;

/** TypeSafe limits (spec 05 §11): Choice 2..255 options, Score 2..10 levels. */
export const CHOICE_MIN_OPTIONS = 2;
export const CHOICE_MAX_OPTIONS = 255;
export const SCORE_MIN_LEVELS = 2;
export const SCORE_MAX_LEVELS = 10;
