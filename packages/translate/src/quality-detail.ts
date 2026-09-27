import { TRANSLATE_SKIP_REASONS } from '@bantoozi/shared';

import type { TranslationAssessment } from './assess.js';
import { isPlainObject, ownValue } from './guards.js';
import { TRANSLATION_POLICY_VERSION } from './policy.js';
import type { TranslationField } from './types.js';

/**
 * `article_translations.quality_detail` (spec 07 §3–4): the translation-policy version, the
 * per-field assessment, a tier failure code, or the reason a wanted tier-2 attempt was skipped.
 * Never article text, provider bodies or keys.
 */

/** Why a wanted tier-2 attempt was not allowed (spec 07 §3; `house.retranslate-skipped` reasons). */
export type Tier2SkipReason = (typeof TRANSLATE_SKIP_REASONS)[number];

export interface TranslationQualityDetail {
  policyVersion: string;
  /** A skipped tier-2 row: the row is stored with `quality = 'fail'` (spec 07 §3). */
  skipped?: Tier2SkipReason;
  /** The credential version at the skip or attempt (metadata only). */
  credentialVersion?: string;
  /** A tier failure code, e.g. `unsupported_language` or `invalid_response` (no text). */
  failure?: string;
  /** The spec 07 §4 assessment with its per-field details. */
  assessment?: TranslationAssessment<TranslationField>;
}

const CREDENTIAL_VERSION = /^[1-9]\d{0,18}$/;
const FAILURE_CODE = /^[a-z][a-z0-9_:]{0,63}$/;

/** The detail of a translated or failed row. */
export function translationQualityDetail(input: {
  assessment?: TranslationAssessment<TranslationField>;
  failure?: string;
  credentialVersion?: string;
}): TranslationQualityDetail {
  if (input.failure !== undefined && !FAILURE_CODE.test(input.failure)) {
    throw new TypeError('quality detail: invalid failure code');
  }
  if (input.credentialVersion !== undefined && !CREDENTIAL_VERSION.test(input.credentialVersion)) {
    throw new TypeError('quality detail: invalid credential version');
  }
  return {
    policyVersion: TRANSLATION_POLICY_VERSION,
    ...(input.failure === undefined ? {} : { failure: input.failure }),
    ...(input.credentialVersion === undefined
      ? {}
      : { credentialVersion: input.credentialVersion }),
    ...(input.assessment === undefined ? {} : { assessment: input.assessment }),
  };
}

/**
 * The detail of a wanted-but-not-allowed tier-2 attempt (spec 07 §3): the handler stores an
 * `ollama` row for the current revision with `quality = 'fail'` and this detail, so the ranker's
 * escalation never re-enqueues it. Only the administrative reprocess replaces such a row.
 */
export function skippedTier2QualityDetail(
  reason: Tier2SkipReason,
  credentialVersion?: string,
): TranslationQualityDetail {
  if (!(TRANSLATE_SKIP_REASONS as readonly string[]).includes(reason)) {
    throw new TypeError('quality detail: invalid skip reason');
  }
  if (credentialVersion !== undefined && !CREDENTIAL_VERSION.test(credentialVersion)) {
    throw new TypeError('quality detail: invalid credential version');
  }
  return {
    policyVersion: TRANSLATION_POLICY_VERSION,
    skipped: reason,
    ...(credentialVersion === undefined ? {} : { credentialVersion }),
  };
}

/** The skip reason of a stored `quality_detail` (any JSON), or `undefined` for a real attempt. */
export function skippedReasonOf(detail: unknown): Tier2SkipReason | undefined {
  if (!isPlainObject(detail)) return undefined;
  const skipped = ownValue(detail, 'skipped');
  return typeof skipped === 'string' &&
    (TRANSLATE_SKIP_REASONS as readonly string[]).includes(skipped)
    ? (skipped as Tier2SkipReason)
    : undefined;
}
