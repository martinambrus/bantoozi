import { describe, expect, it } from 'vitest';

import {
  eligibleSetSha,
  eligibilityOf,
  snapshotFeatures,
  trainUserModel,
} from '../../src/index.js';
import { block, driftSamples } from './support/drift.js';
import { OTHER_RATING_SHA, RATING_SHA, trainArgs } from './support/synth.js';

function fixture() {
  const samples = driftSamples({
    seed: 'drift-a',
    interleave: false,
    blocks: [block(OTHER_RATING_SHA, 400, 1, 0), block(RATING_SHA, 30, -1, 0.4)],
  });
  // Thirty ratings during the rebuild have the new sha but healthy old-release answers.
  for (const s of [...samples.slice(0, 15), ...samples.slice(200, 215)]) {
    Object.assign(s.features!, { ratingSha: RATING_SHA, staleAnswers: true });
  }
  return samples;
}

describe('stale answers after a model upgrade', () => {
  it('masks stale rows from the guard and trips at 30 genuine ratings despite contamination', () => {
    const samples = fixture();
    const result = trainUserModel(trainArgs(samples), { mode: 'production' });
    expect(result.metrics.nExplicit).toBe(430); // relaxed training still pools every row
    expect(result.metrics.upgrade).toMatchObject({ n: 30, nPos: 15, nNeg: 15, regressed: true });
    expect(result.activation.reasons).toContain('upgrade_regression');
  });

  it('stale rows cannot supply the guard minimum; refreshed and legacy snapshots count', () => {
    const samples = fixture();
    Object.assign(samples.at(-1)!.features!, { staleAnswers: true });
    expect(trainUserModel(trainArgs(samples), { mode: 'production' }).metrics.upgrade).toBeNull();
    Object.assign(samples.at(-1)!.features!, { staleAnswers: false });
    expect(trainUserModel(trainArgs(samples), { mode: 'production' }).metrics.upgrade?.n).toBe(30);
  });

  it('strict training excludes stale rows, with matching eligible-set hashing and skip counts', () => {
    const samples = fixture();
    const args = { ...trainArgs(samples), families: {}, strict: true };
    const result = trainUserModel(args, { mode: 'production' });
    expect(result.metrics.nExplicit).toBe(30);
    expect(result.metrics.skipped).toEqual({ rating_sha_mismatch: 370, stale_answers: 30 });
    const fresh = samples.slice(400);
    expect(eligibleSetSha(samples, eligibilityOf(args))).toBe(
      eligibleSetSha(fresh, eligibilityOf(args)),
    );
    // Re-analysis refresh is represented by a new all-current snapshot of the same rating.
    Object.assign(samples[0]!.features!, { staleAnswers: false });
    expect(trainUserModel(args, { mode: 'production' }).metrics.nExplicit).toBe(31);
  });

  it('the marker is metadata: feature vectors and relaxed eligibility do not change', () => {
    const s = fixture()[0]!;
    const args = trainArgs([s]);
    const vector = snapshotFeatures(s.features!, args.config, []);
    Object.assign(s.features!, { staleAnswers: false });
    expect(snapshotFeatures(s.features!, args.config, [])).toEqual(vector);
    const relaxed = trainUserModel(args, { mode: 'production' });
    expect(relaxed.metrics.nExplicit).toBe(1);
    expect(relaxed.metrics.skipped).toEqual({});
  });
});
