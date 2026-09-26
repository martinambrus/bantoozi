import { TRANSLATE_SKIP_REASONS } from '@bantoozi/shared';

import { skippedReasonOf, type Tier2SkipReason } from './quality-detail.js';
import type { TranslationEngine, TranslationQuality, TranslationTexts } from './types.js';

/**
 * Pure selection rules over `article_translations` rows (spec 07 §3): which row the state builder
 * uses (step 4, spec 05 §3.1), whether tier 2 is wanted (step 3) and whether it may still run for
 * the current revision.
 */

/** The row fields the rules read (a DB row or a projection of one). */
export interface TranslationRowSummary {
  engine: TranslationEngine;
  quality: TranslationQuality;
  /** `article_translations.article_revision` (decimal bigint string). */
  articleRevision: string | bigint;
  /** Default `en`; rows for another target are ignored. */
  targetLang?: string;
  /** `quality_detail`, to recognize a skipped tier-2 row. */
  qualityDetail?: unknown;
}

const QUALITY_RANK: Readonly<Record<TranslationQuality, number>> = { fail: 0, weak: 1, ok: 2 };
const DECIMAL = /^(?:0|[1-9]\d*)$/;

function revision(value: string | bigint): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    throw new TypeError('translation rows: a revision must be a decimal bigint string');
  }
  return BigInt(value);
}

/** Rows valid for the article's current content revision (earlier ones are ineligible). */
function currentRows<R extends TranslationRowSummary>(
  rows: Iterable<R>,
  currentRevision: string | bigint,
): R[] {
  const current = revision(currentRevision);
  const selected: R[] = [];
  for (const row of rows) {
    if ((row.targetLang ?? 'en') !== 'en') continue;
    if (revision(row.articleRevision) === current) selected.push(row);
  }
  return selected;
}

/**
 * The best translation among the current-revision rows (spec 07 §3 step 4): the highest quality,
 * `ok` > `weak` > `fail`, ties preferring `ollama`. `null` when only `fail` rows (skipped tier-2
 * rows included) or none exist: the state is then built from native text.
 */
export function selectBestTranslation<R extends TranslationRowSummary>(
  rows: Iterable<R>,
  currentRevision: string | bigint,
): R | null {
  let best: R | null = null;
  for (const row of currentRows(rows, currentRevision)) {
    if (best === null) {
      best = row;
      continue;
    }
    const byQuality = QUALITY_RANK[row.quality] - QUALITY_RANK[best.quality];
    if (byQuality > 0 || (byQuality === 0 && row.engine === 'ollama' && best.engine !== 'ollama')) {
      best = row;
    }
  }
  return best === null || best.quality === 'fail' ? null : best;
}

/** The current-revision `ollama` row, a skipped one included. */
export function currentTier2Row<R extends TranslationRowSummary>(
  rows: Iterable<R>,
  currentRevision: string | bigint,
): R | undefined {
  return currentRows(rows, currentRevision).find((row) => row.engine === 'ollama');
}

/**
 * Whether a tier-2 attempt may run for the current revision (spec 07 §3). It runs once per content
 * revision: an existing current `ollama` row, even a skipped one, prevents repeats, so budget reset
 * or queue redelivery never retries. The administrative reprocess (`replaceSkipped`) may replace a
 * row skipped for one of `reasons` (default all), never a real attempt.
 */
export function mayRunTier2(
  rows: Iterable<TranslationRowSummary>,
  currentRevision: string | bigint,
  options: { replaceSkipped?: boolean; reasons?: readonly Tier2SkipReason[] } = {},
): boolean {
  const row = currentTier2Row(rows, currentRevision);
  if (row === undefined) return true;
  if (options.replaceSkipped !== true) return false;
  const skipped = skippedReasonOf(row.qualityDetail);
  return skipped !== undefined && (options.reasons ?? TRANSLATE_SKIP_REASONS).includes(skipped);
}

export type Tier2Reason = 'tier1_fail' | 'forced' | 'translate_strong';

export type Tier2Decision =
  | { wanted: false }
  | {
      wanted: true;
      reasons: Tier2Reason[];
      /**
       * `strong` (`OLLAMA_MODEL_STRONG`) only for a feed flagged `translate_strong`, the admin
       * "hard feed" flag; otherwise `fast` (`OLLAMA_MODEL_FAST`) (spec 07 §2).
       */
      modelTier: 'fast' | 'strong';
    };

/**
 * Whether tier 2 is WANTED (spec 07 §3 step 3): tier-1 quality `fail`, `forceTier2` (the ranker's
 * weak-translation escalation or the reprocess, spec 06 §7), or the feed's
 * `fetch_options.translate_strong`. Whether it is ALLOWED (key, cap, budget, demand) is decided by
 * the handler per attempt; a wanted-but-not-allowed attempt leaves a skipped row.
 */
export function decideTier2(input: {
  /** The tier-1 row's quality; `null`/absent when tier 1 did not produce a row. */
  tier1Quality?: TranslationQuality | null;
  forceTier2?: boolean;
  translateStrong?: boolean;
}): Tier2Decision {
  const reasons: Tier2Reason[] = [];
  if (input.tier1Quality === 'fail') reasons.push('tier1_fail');
  if (input.forceTier2 === true) reasons.push('forced');
  if (input.translateStrong === true) reasons.push('translate_strong');
  if (reasons.length === 0) return { wanted: false };
  return { wanted: true, reasons, modelTier: input.translateStrong === true ? 'strong' : 'fast' };
}

/**
 * Whether two selections give the model the same effective text (spec 07 §3 re-translation):
 * `null` is native text. Comparing quality grades alone would miss a different tie-winning
 * translation, so the texts are compared.
 */
export function sameTranslationText(
  a: TranslationTexts | null,
  b: TranslationTexts | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.title === b.title && a.excerpt === b.excerpt && a.body_lead === b.body_lead;
}
