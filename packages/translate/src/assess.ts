import { normalizeText } from '@bantoozi/shared';
import { detectLanguage } from '@bantoozi/shared/server';

import { isPlainObject } from './guards.js';
import { codePoints } from './http.js';
import type { TranslationField, TranslationQuality } from './types.js';

/**
 * `assessTranslation(source, output, sourceLang)` (spec 07 §4), pure. It catches obvious breakage
 * (empty, truncated, looping or untranslated output), not semantic accuracy; G1 reviews that.
 *
 * 1. Shape first: `output` must be an object with no keys beyond the source's. Every nonblank
 *    source field needs a nonblank string, whatever its length; otherwise the article fails. An
 *    absent (blank) source field stays excluded. An entirely blank source is skipped, not `ok`.
 * 2. For each field whose source has at least 20 characters: a length ratio outside [0.4, 2.5]
 *    or a model loop fails: a word 3-gram repeated more than max(4, 2 × the source's own most
 *    repeated 3-gram + 2) times (a translation keeps the source's repetition, and English adds
 *    function-word 3-grams such as "of the slovak" that Slovak and Czech lack; D-144); more than half of the output
 *    tokens (≥ 4 characters, normalized) also appearing in the source is weak (untranslated);
 *    `detectLanguage(output)` naming a known non-English language with confidence ≥ 0.1 is weak.
 * 3. The worst field wins. Shorter fields and a detector `und` are inconclusive: neither proves
 *    success or failure, so they never lower the grade. Names and brands survive translation, so
 *    the 0.5 share is deliberately lenient.
 */

/** The spec 07 §4 thresholds. */
export const ASSESSMENT_THRESHOLDS = Object.freeze({
  /** Per-field checks apply from this source length (code points). */
  minSourceChars: 20,
  minLengthRatio: 0.4,
  maxLengthRatio: 2.5,
  /** A 3-gram repeated MORE than this many times fails, at least (D-144). */
  maxTrigramRepeats: 4,
  /** The loop limit also allows this multiple of the source's own most repeated 3-gram… */
  sourceTrigramRepeatsFactor: 2,
  /** …plus this many repeats. */
  sourceTrigramRepeatsSlack: 2,
  /** Tokens shorter than this are ignored by the untranslated-share check. */
  minTokenChars: 4,
  /** A shared-token share ABOVE this is weak. */
  maxSharedTokenShare: 0.5,
  /** A non-English detection at or above this confidence is weak. */
  minNonEnglishConfidence: 0.1,
});

/** A field's grade; `inconclusive` (short source) and `absent` never lower the article's grade. */
export type FieldResult = TranslationQuality | 'inconclusive' | 'absent';

export type FieldReason =
  | 'missing_output'
  | 'not_a_string'
  | 'empty_output'
  | 'short_source'
  | 'length_ratio'
  | 'repeated_trigram'
  | 'untranslated_share'
  | 'non_english';

/** Per-field details, JSON-serializable for `quality_detail` (ratios rounded to 3 decimals). */
export interface FieldAssessment {
  result: FieldResult;
  reasons: FieldReason[];
  sourceChars: number;
  outputChars?: number;
  lengthRatio?: number;
  maxTrigramRepeats?: number;
  /** The source's own most repeated 3-gram count, which raises the loop limit (D-144). */
  sourceMaxTrigramRepeats?: number;
  /** Absent when the output has no token of at least 4 characters. */
  sharedTokenShare?: number;
  detected?: { lang: string; confidence: number };
}

export type ShapeProblem = 'not_an_object' | 'extra_keys';

export type TranslationAssessment<F extends string = TranslationField> =
  | { skipped: true; reason: 'empty_input'; sourceLang: string }
  | {
      skipped: false;
      quality: TranslationQuality;
      /** False when no field was long enough for the per-field checks (nothing proved). */
      conclusive: boolean;
      shape: 'ok' | ShapeProblem;
      sourceLang: string;
      fields: Record<F, FieldAssessment>;
    };

const RANK: Readonly<Record<TranslationQuality, number>> = { ok: 0, weak: 1, fail: 2 };

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

function tokens(text: string): string[] {
  const normalized = normalizeText(text);
  return normalized === '' ? [] : normalized.split(' ');
}

/**
 * The most repeats a translation of a source whose most frequent 3-gram occurs `sourceRepeats`
 * times may have before it counts as a model loop (D-144).
 */
export function trigramRepeatLimit(sourceRepeats: number): number {
  const t = ASSESSMENT_THRESHOLDS;
  return Math.max(
    t.maxTrigramRepeats,
    t.sourceTrigramRepeatsFactor * sourceRepeats + t.sourceTrigramRepeatsSlack,
  );
}

/** How often the most frequent word 3-gram occurs. */
export function maxTrigramRepeats(text: string): number {
  const words = tokens(text);
  const counts = new Map<string, number>();
  let max = 0;
  for (let i = 0; i + 2 < words.length; i += 1) {
    const key = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count > max) max = count;
  }
  return max;
}

/**
 * Share of the output's tokens (at least 4 characters, normalized) that also occur in the source;
 * `undefined` when the output has no such token.
 */
export function sharedTokenShare(source: string, output: string): number | undefined {
  const candidates = tokens(output).filter(
    (token) => codePoints(token) >= ASSESSMENT_THRESHOLDS.minTokenChars,
  );
  if (candidates.length === 0) return undefined;
  const sourceTokens = new Set(tokens(source));
  return candidates.filter((token) => sourceTokens.has(token)).length / candidates.length;
}

function assessField(source: string, output: unknown, present: boolean): FieldAssessment {
  const sourceText = source.trim();
  const sourceChars = codePoints(sourceText);
  if (!present) return { result: 'fail', reasons: ['missing_output'], sourceChars };
  if (typeof output !== 'string') {
    return {
      result: 'fail',
      reasons: [output === null || output === undefined ? 'missing_output' : 'not_a_string'],
      sourceChars,
    };
  }
  const outputText = output.trim();
  const outputChars = codePoints(outputText);
  if (outputChars === 0) {
    return { result: 'fail', reasons: ['empty_output'], sourceChars, outputChars };
  }
  if (sourceChars < ASSESSMENT_THRESHOLDS.minSourceChars) {
    return { result: 'inconclusive', reasons: ['short_source'], sourceChars, outputChars };
  }

  const reasons: FieldReason[] = [];
  const lengthRatio = outputChars / sourceChars;
  if (
    lengthRatio < ASSESSMENT_THRESHOLDS.minLengthRatio ||
    lengthRatio > ASSESSMENT_THRESHOLDS.maxLengthRatio
  ) {
    reasons.push('length_ratio');
  }
  const repeats = maxTrigramRepeats(outputText);
  const sourceRepeats = maxTrigramRepeats(sourceText);
  if (repeats > trigramRepeatLimit(sourceRepeats)) reasons.push('repeated_trigram');
  const share = sharedTokenShare(sourceText, outputText);
  if (share !== undefined && share > ASSESSMENT_THRESHOLDS.maxSharedTokenShare) {
    reasons.push('untranslated_share');
  }
  const detected = detectLanguage(outputText);
  if (
    detected.lang !== 'und' &&
    detected.lang !== 'en' &&
    detected.confidence >= ASSESSMENT_THRESHOLDS.minNonEnglishConfidence
  ) {
    reasons.push('non_english');
  }

  const failed = reasons.includes('length_ratio') || reasons.includes('repeated_trigram');
  return {
    result: failed ? 'fail' : reasons.length > 0 ? 'weak' : 'ok',
    reasons,
    sourceChars,
    outputChars,
    lengthRatio: round3(lengthRatio),
    maxTrigramRepeats: repeats,
    sourceMaxTrigramRepeats: sourceRepeats,
    ...(share === undefined ? {} : { sharedTokenShare: round3(share) }),
    detected: { lang: detected.lang, confidence: round3(detected.confidence) },
  };
}

/**
 * Assesses `output` (untrusted: a tier-2 JSON object or the tier-1 mapping) against `source`,
 * whose keys are the fields (`{title, excerpt, body_lead}` for articles, `{interest, not_for}`
 * for cards; `null`/blank = absent). `sourceLang` is recorded with the result.
 */
export function assessTranslation<F extends string>(
  source: Readonly<Record<F, string | null | undefined>>,
  output: unknown,
  sourceLang: string,
): TranslationAssessment<F> {
  const keys = Object.keys(source) as F[];
  const present = keys.filter((key) => {
    const value: unknown = source[key];
    if (value !== null && value !== undefined && typeof value !== 'string') {
      throw new TypeError(`assessTranslation: source field ${key} is not a string`);
    }
    return typeof value === 'string' && value.trim() !== '';
  });
  if (present.length === 0) return { skipped: true, reason: 'empty_input', sourceLang };

  const object = isPlainObject(output) ? output : undefined;
  let shape: 'ok' | ShapeProblem = object === undefined ? 'not_an_object' : 'ok';
  if (object !== undefined && Object.keys(object).some((key) => !keys.includes(key as F))) {
    shape = 'extra_keys';
  }

  const fields = {} as Record<F, FieldAssessment>;
  let worst: TranslationQuality | undefined;
  for (const key of keys) {
    if (!present.includes(key)) {
      fields[key] = { result: 'absent', reasons: [], sourceChars: 0 };
      continue;
    }
    const has = object !== undefined && Object.hasOwn(object, key);
    const field = assessField(source[key] as string, has ? object[key] : undefined, has);
    fields[key] = field;
    if (field.result === 'ok' || field.result === 'weak' || field.result === 'fail') {
      if (worst === undefined || RANK[field.result] > RANK[worst]) worst = field.result;
    }
  }

  if (shape !== 'ok') {
    return { skipped: false, quality: 'fail', conclusive: true, shape, sourceLang, fields };
  }
  return {
    skipped: false,
    quality: worst ?? 'ok',
    conclusive: worst !== undefined,
    shape,
    sourceLang,
    fields,
  };
}
