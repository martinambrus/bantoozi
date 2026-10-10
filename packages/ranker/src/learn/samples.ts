import { canonicalSha256 } from '@bantoozi/shared/server';

import { isProbability } from '../lanes.js';
import { FEATURE_SPEC_V1_FACET_NAMES, RAW_SNAPSHOT_SPEC_SHA } from './feature-spec.js';
import type { RawFeatureSnapshot } from './features.js';

const DAY_MS = 86_400_000;
const FOREIGN_ENGINES: ReadonlySet<string> = new Set(['llm', 'laya']);

/** One current sample per user/article (spec 06 §8.2); `features` is the stored event-time snapshot. */
export interface TrainingSample {
  articleId: string;
  eventId?: string;
  signal?: string;
  y: 0 | 1;
  weight: number;
  explicit: boolean;
  feedbackAt: Date;
  groupId: string;
  features: RawFeatureSnapshot | null;
}

export type EligibilityReason =
  | 'missing_snapshot'
  | 'spec_sha_mismatch'
  | 'rating_sha_mismatch'
  | 'too_old'
  | 'no_facets'
  | 'invalid_facets'
  | 'foreign_engine'
  | 'incomplete_coverage'
  | 'no_positive_cards';

export interface EligibilityOpts {
  now: Date;
  historyDays: number;
  ratingSha: string | null;
}

/**
 * Whether a sample may be trained on (spec 06 §8.1-8.2): a stored event-time snapshot of the current
 * raw snapshot spec and rating fingerprint (both checks are skipped for a null `ratingSha`), within the
 * history window, with valid typesafe facets and complete positive-card coverage. Never reconstructs.
 */
export function sampleEligibility(
  s: TrainingSample,
  opts: EligibilityOpts,
): { ok: true } | { ok: false; reason: EligibilityReason } {
  const f = s.features;
  if (f === null) return { ok: false, reason: 'missing_snapshot' };
  if (opts.ratingSha !== null) {
    if (f.specSha !== RAW_SNAPSHOT_SPEC_SHA) return { ok: false, reason: 'spec_sha_mismatch' };
    if (f.ratingSha !== opts.ratingSha) return { ok: false, reason: 'rating_sha_mismatch' };
  }
  const cutoff = opts.now.getTime() - opts.historyDays * DAY_MS;
  const snapshotAt = typeof f.snapshotAt === 'string' ? Date.parse(f.snapshotAt) : Number.NaN;
  if (s.feedbackAt.getTime() < cutoff || (!Number.isNaN(snapshotAt) && snapshotAt < cutoff)) {
    return { ok: false, reason: 'too_old' };
  }
  const { facets, facetsEngine } = f.values;
  if (facets === null || facets === undefined) return { ok: false, reason: 'no_facets' };
  for (const name of FEATURE_SPEC_V1_FACET_NAMES) {
    const value: unknown = Object.hasOwn(facets, name) ? facets[name] : undefined;
    if (!isProbability(value)) return { ok: false, reason: 'invalid_facets' };
  }
  if (
    (facetsEngine !== null && FOREIGN_ENGINES.has(facetsEngine)) ||
    f.cards.some((c) => c.engine !== null && FOREIGN_ENGINES.has(c.engine))
  ) {
    return { ok: false, reason: 'foreign_engine' };
  }
  const positive = f.cards.filter((c) => c.strength !== 'never');
  if (positive.some((c) => c.engine === 'prefilter' || !isProbability(c.p))) {
    return { ok: false, reason: 'incomplete_coverage' };
  }
  if (positive.length === 0) return { ok: false, reason: 'no_positive_cards' };
  return { ok: true };
}

/** Canonical sample order: article id, then event id. */
export function compareSamples(a: TrainingSample, b: TrainingSample): number {
  const x = `${a.articleId}\u0000${a.eventId ?? ''}`;
  const y = `${b.articleId}\u0000${b.eventId ?? ''}`;
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * The fingerprint of the eligible training set (spec 06 §8.3 reproducibility): order-independent,
 * and sensitive to labels, weights, groups, snapshots and to `now` expiring a sample.
 */
export function eligibleSetSha(samples: readonly TrainingSample[], opts: EligibilityOpts): string {
  const eligible = samples.filter((s) => sampleEligibility(s, opts).ok).sort(compareSamples);
  return canonicalSha256(
    eligible.map((s) => ({
      articleId: s.articleId,
      eventId: s.eventId ?? null,
      signal: s.signal ?? null,
      y: s.y,
      weight: s.weight,
      explicit: s.explicit,
      feedbackAt: s.feedbackAt.toISOString(),
      groupId: s.groupId,
      features: canonicalSha256(s.features),
    })),
  );
}
