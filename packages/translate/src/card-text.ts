import { detectLanguage } from '@bantoozi/shared/server';

import { assessTranslation, type TranslationAssessment } from './assess.js';
import type { LibreTranslateClient, Tier1FailureReason } from './libretranslate.js';
import { isBlankText, sourceFields } from './source.js';
import type { TranslationAttempt } from './types.js';

/**
 * Card text translation for `CARD_TEXT_MODE = 'english'` (spec 07 §5), run by the API before it
 * inserts a card row: detect the language of `interest + ' ' + not_for` with the user's locale as
 * hint, and translate the pair with tier 1 only when the language is a known, non-English language
 * with an installed `→ en` model. `en`, `und` and unsupported languages keep the original text
 * without a request; there is no tier 2 for cards. A locale hint is a fallback for ambiguous short
 * text, not proof of language: when only the hint (not the detector) says non-English, the original
 * is kept, so an English brand-only phrase is never translated because the UI locale is Slovak.
 *
 * The pair is published only as a whole and only when its assessment is `ok`; on a partial, weak or
 * failed translation the original pair is used and a non-blocking status is returned. The original
 * text (and so the card hash) is never changed.
 */

export type CardTextField = 'interest' | 'not_for';

/**
 * - `translated`: `interestEn`/`notForEn` hold the validated pair
 * - `english`, `undetermined` (`und`), `unconfirmed` (only the locale hint says non-English) and
 *   `unsupported` (no installed model): original text, no request
 * - `weak`, `failed`: a translation was attempted; original text
 */
export type CardTextStatus =
  'translated' | 'english' | 'undetermined' | 'unconfirmed' | 'unsupported' | 'weak' | 'failed';

export interface CardTextTranslation {
  /** `interest_cards.lang`: the hinted detection (spec 07 §5 step 1). */
  lang: string;
  status: CardTextStatus;
  /** Set only with `translated`. */
  interestEn: string | null;
  /** Set only with `translated` and a nonblank `not_for`. */
  notForEn: string | null;
  /** The assessment of an attempted translation. */
  assessment?: TranslationAssessment<CardTextField>;
  /** The tier-1 failure reason of `failed` without an assessment. */
  failure?: Tier1FailureReason;
  /** Every HTTP attempt, for the API's external-call accounting (failures included). */
  attempts: TranslationAttempt[];
}

/** Card text uses a lower detection threshold than articles (spec 07 §5, spec 03 §8.3). */
export const CARD_TEXT_MIN_DETECT_LENGTH = 10;

export async function translateCardText(
  client: Pick<LibreTranslateClient, 'translate'>,
  input: {
    interest: string;
    notFor?: string | null;
    /** The user's locale (e.g. `sk`, `sk-SK`): a hint for ambiguous short text only. */
    locale?: string | null;
    /** Source languages with an installed `→ en` model (from a cached `/languages`). */
    supportedSources: ReadonlySet<string>;
    signal?: AbortSignal;
  },
): Promise<CardTextTranslation> {
  if (typeof input.interest !== 'string' || isBlankText(input.interest)) {
    throw new TypeError('translateCardText: interest must be a nonblank string');
  }
  const notFor = isBlankText(input.notFor) ? null : (input.notFor as string);
  const text = `${input.interest} ${notFor ?? ''}`;
  const { lang } = detectLanguage(text, {
    hint: input.locale,
    minLength: CARD_TEXT_MIN_DETECT_LENGTH,
  });
  const original = (status: CardTextStatus): CardTextTranslation => ({
    lang,
    status,
    interestEn: null,
    notForEn: null,
    attempts: [],
  });
  if (lang === 'en') return original('english');
  if (lang === 'und') return original('undetermined');
  const evidence = detectLanguage(text, { minLength: CARD_TEXT_MIN_DETECT_LENGTH });
  if (evidence.lang === 'en' || evidence.lang === 'und') return original('unconfirmed');
  if (!input.supportedSources.has(lang)) return original('unsupported');

  const source: Record<CardTextField, string | null> = {
    interest: input.interest,
    not_for: notFor,
  };
  const result = await client.translate({
    fields: sourceFields(source, ['interest', 'not_for'] as const),
    source: lang,
    supportedSources: input.supportedSources,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (result.status !== 'translated') {
    return {
      ...original('failed'),
      ...(result.status === 'failed' ? { failure: result.reason } : {}),
      attempts: result.attempts,
    };
  }
  const output: Record<CardTextField, string | null> = { interest: null, not_for: null };
  for (const { field, text: translated } of result.translations) output[field] = translated;
  const assessment = assessTranslation(source, output, lang);
  const quality = assessment.skipped ? 'fail' : assessment.quality;
  if (quality !== 'ok') {
    return {
      ...original(quality === 'weak' ? 'weak' : 'failed'),
      assessment,
      attempts: result.attempts,
    };
  }
  return {
    lang,
    status: 'translated',
    interestEn: output.interest,
    notForEn: notFor === null ? null : output.not_for,
    assessment,
    attempts: result.attempts,
  };
}
