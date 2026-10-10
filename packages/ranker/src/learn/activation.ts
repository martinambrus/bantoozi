import type { ReadonlyRankerConfig } from '../config.js';

export interface ActivationInput {
  nExplicit: number;
  nPos: number;
  nNeg: number;
  cvAuc: number | null;
  cvLogloss: number | null;
  baselineAuc: number | null;
  baselineLogloss: number | null;
}

/** The minimum-evidence reasons of spec 06 §8.3 (explicit count, then class counts). */
export function minimumReasons(m: ActivationInput, cfg: ReadonlyRankerConfig['model']): string[] {
  const reasons: string[] = [];
  if (m.nExplicit < cfg.minExplicit) reasons.push('insufficient_explicit');
  if (m.nPos < cfg.minEachClass || m.nNeg < cfg.minEachClass) reasons.push('insufficient_class');
  return reasons;
}

/** The quality reasons of spec 06 §8.3 over the nested out-of-fold metrics and the baseline. */
export function qualityReasons(m: ActivationInput, cfg: ReadonlyRankerConfig['model']): string[] {
  const reasons: string[] = [];
  if (m.cvAuc === null || m.cvAuc < cfg.minCvAuc) reasons.push('low_auc');
  if (m.cvAuc !== null && m.baselineAuc !== null && m.cvAuc < m.baselineAuc - cfg.maxBaselineDrop) {
    reasons.push('below_baseline_auc');
  }
  if (m.cvLogloss === null || (m.baselineLogloss !== null && m.cvLogloss > m.baselineLogloss)) {
    reasons.push('worse_logloss');
  }
  return reasons;
}

/**
 * Whether a candidate may become the active model now (spec 06 §8.1, §8.3): its own reasons plus
 * `rating_fingerprint_changed` and `context_changed` against the current state.
 */
export function decideActivation(
  candidate: {
    model: { ratingSha?: string | null } | null;
    metrics: { ratingSha?: string | null; contextSha: string | null };
    activation: { eligible: boolean; reasons: string[] };
  },
  current: { currentRatingSha: string; currentContextSha: string },
): { activate: boolean; reasons: string[] } {
  const reasons = [...candidate.activation.reasons];
  const ratingSha = candidate.metrics.ratingSha ?? candidate.model?.ratingSha ?? null;
  if (ratingSha !== current.currentRatingSha) reasons.push('rating_fingerprint_changed');
  if (candidate.metrics.contextSha !== current.currentContextSha) reasons.push('context_changed');
  return {
    activate: candidate.activation.eligible && candidate.model !== null && reasons.length === 0,
    reasons,
  };
}
