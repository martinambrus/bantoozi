import { canonicalSha256 } from '@bantoozi/shared/server';

import { isProbability } from '../lanes.js';
import { FEATURE_SPEC_V1_FACET_NAMES, RAW_SNAPSHOT_SPEC_SHA } from './feature-spec.js';
import type { RawFeatureSnapshot } from './features.js';

const DAY_MS = 86_400_000;
/** FEATURE_SPEC_V1's engine family: facets and card answers must come from TypeSafe (spec 06 §8.1). */
const FEATURE_ENGINE = 'typesafe';

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
  /** The dislike reason of the effective rating event, null when none. */
  reason?: string | null;
  features: RawFeatureSnapshot | null;
}

export type EligibilityReason =
  | 'missing_snapshot'
  | 'spec_sha_mismatch'
  | 'rating_sha_mismatch'
  | 'stale_answers'
  | 'too_old'
  | 'no_facets'
  | 'invalid_facets'
  | 'foreign_engine'
  | 'incomplete_coverage'
  | 'no_positive_cards';

/**
 * The eligibility scope: a null `ratingSha` skips the spec and rating checks; otherwise a sample is
 * rating-compatible with the exact sha or with any sha `families` maps to `familySha`.
 */
export type EligibilityOpts = { now: Date; historyDays: number } & (
  | { ratingSha: null }
  | {
      ratingSha: string;
      familySha: string;
      families: Readonly<Record<string, string>>;
      strict?: boolean;
    }
);

export function isValidFeatureFacets(facets: unknown): facets is Record<string, number> {
  if (typeof facets !== 'object' || facets === null || Array.isArray(facets)) return false;
  return FEATURE_SPEC_V1_FACET_NAMES.every(
    (name) => Object.hasOwn(facets, name) && isProbability(Reflect.get(facets, name)),
  );
}

function ratingScopeOf(opts: EligibilityOpts): { familySha: string; families: object } | null {
  if (opts.ratingSha === null) return null;
  const scope = opts as { familySha?: unknown; families?: unknown };
  if (
    typeof scope.familySha !== 'string' ||
    typeof scope.families !== 'object' ||
    scope.families === null
  ) {
    throw new TypeError('sampleEligibility: a rating sha needs familySha and families');
  }
  return { familySha: scope.familySha, families: scope.families };
}

/**
 * Whether a sample may be trained on (spec 06 §8.1-8.2): a stored event-time snapshot of the current
 * raw snapshot spec and rating fingerprint family (both checks are skipped for a null `ratingSha`), within the
 * history window, with valid typesafe facets and complete positive-card coverage. Never reconstructs.
 */
export function sampleEligibility(
  s: TrainingSample,
  opts: EligibilityOpts,
): { ok: true } | { ok: false; reason: EligibilityReason } {
  const scope = ratingScopeOf(opts);
  const f = s.features;
  if (f === null) return { ok: false, reason: 'missing_snapshot' };
  if (scope !== null && opts.ratingSha !== null) {
    if (f.specSha !== RAW_SNAPSHOT_SPEC_SHA) return { ok: false, reason: 'spec_sha_mismatch' };
    const sha = f.ratingSha;
    const compatible =
      sha === opts.ratingSha ||
      (opts.strict !== true &&
        Object.hasOwn(scope.families, sha) &&
        Reflect.get(scope.families, sha) === scope.familySha);
    if (!compatible) return { ok: false, reason: 'rating_sha_mismatch' };
    if (opts.strict === true && f.staleAnswers === true) {
      return { ok: false, reason: 'stale_answers' };
    }
  }
  const cutoff = opts.now.getTime() - opts.historyDays * DAY_MS;
  const snapshotAt = typeof f.snapshotAt === 'string' ? Date.parse(f.snapshotAt) : Number.NaN;
  if (s.feedbackAt.getTime() < cutoff || (!Number.isNaN(snapshotAt) && snapshotAt < cutoff)) {
    return { ok: false, reason: 'too_old' };
  }
  const { facets, facetsEngine } = f.values;
  if (facets === null || facets === undefined) return { ok: false, reason: 'no_facets' };
  if (!isValidFeatureFacets(facets)) return { ok: false, reason: 'invalid_facets' };
  if (
    facetsEngine !== FEATURE_ENGINE ||
    f.cards.some((c) =>
      c.engine === null ? c.p !== null : c.engine !== FEATURE_ENGINE && c.engine !== 'prefilter',
    )
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
