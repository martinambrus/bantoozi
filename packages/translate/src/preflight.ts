import { assessTranslation } from './assess.js';
import {
  REQUIRED_TIER1_PAIRS,
  missingLanguagePairs,
  type LibreTranslateClient,
  type Tier1FailureReason,
} from './libretranslate.js';
import type { TranslationAttempt, TranslationQuality } from './types.js';

/**
 * Tier-1 capability check (spec 07 §2): "Read `/languages` and verify `sk→en` and `cs→en` with
 * fixture translations before G1. A language being detectable does not mean a translation model is
 * installed." Used by the preflight/eval tooling; each fixture translation must assess `ok`.
 */

/** One fixed sentence per required pair. */
export const TIER1_PREFLIGHT_SAMPLES: ReadonlyArray<{ lang: string; text: string }> = Object.freeze(
  [
    {
      lang: 'sk',
      text: 'Vláda v utorok schválila nový rozpočet na verejnú dopravu v Bratislave a na opravu mostov.',
    },
    {
      lang: 'cs',
      text: 'Vláda v úterý schválila nový rozpočet na veřejnou dopravu v Praze a na opravy mostů.',
    },
  ],
);

export interface Tier1Verification {
  ok: boolean;
  /** `/languages` could not be read. */
  languagesFailure?: Tier1FailureReason;
  /** Required pairs that `/languages` does not list. */
  missingPairs: Array<[string, string]>;
  samples: Array<{
    lang: string;
    /** `ok`/`weak`/`fail` from spec 07 §4; `failed` when the request failed. */
    outcome: TranslationQuality | 'failed' | 'not_requested';
    failure?: Tier1FailureReason;
  }>;
  attempts: TranslationAttempt[];
}

export async function verifyTier1(
  client: Pick<LibreTranslateClient, 'languages' | 'translate'>,
  options: {
    pairs?: ReadonlyArray<readonly [string, string]>;
    samples?: ReadonlyArray<{ lang: string; text: string }>;
    signal?: AbortSignal;
  } = {},
): Promise<Tier1Verification> {
  const pairs = options.pairs ?? REQUIRED_TIER1_PAIRS;
  const signal = options.signal === undefined ? {} : { signal: options.signal };
  const listed = await client.languages(signal);
  const attempts: TranslationAttempt[] = [listed.attempt];
  if (!listed.ok) {
    return {
      ok: false,
      languagesFailure: listed.reason,
      missingPairs: pairs.map(([source, target]): [string, string] => [source, target]),
      samples: [],
      attempts,
    };
  }
  const missingPairs = missingLanguagePairs(listed.languages, pairs);
  const samples: Tier1Verification['samples'] = [];
  for (const sample of options.samples ?? TIER1_PREFLIGHT_SAMPLES) {
    if (missingPairs.some(([source, target]) => source === sample.lang && target === 'en')) {
      samples.push({ lang: sample.lang, outcome: 'not_requested' });
      continue;
    }
    const result = await client.translate({
      fields: [{ field: 'text', text: sample.text }],
      source: sample.lang,
      ...signal,
    });
    attempts.push(...result.attempts);
    if (result.status === 'failed') {
      samples.push({ lang: sample.lang, outcome: 'failed', failure: result.reason });
      continue;
    }
    if (result.status !== 'translated') {
      samples.push({ lang: sample.lang, outcome: 'not_requested' });
      continue;
    }
    const assessment = assessTranslation(
      { text: sample.text },
      { text: result.translations[0]?.text ?? null },
      sample.lang,
    );
    samples.push({ lang: sample.lang, outcome: assessment.skipped ? 'fail' : assessment.quality });
  }
  return {
    ok: missingPairs.length === 0 && samples.every((sample) => sample.outcome === 'ok'),
    missingPairs,
    samples,
    attempts,
  };
}
