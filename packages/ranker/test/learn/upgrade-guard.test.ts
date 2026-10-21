import { describe, expect, it } from 'vitest';

import { auc, snapshotCardScore } from '../../src/index.js';
import { api } from './support/api.js';
import type { TrainArgs, TrainResult, TrainingSample, UpgradeMetrics } from './support/api.js';
import { block, driftFixture, driftSamples, healthyFixture } from './support/drift.js';
import { CFG, OTHER_RATING_SHA, RATING_SHA, trainArgs } from './support/synth.js';

const UNREGISTERED_SHA = 'e'.repeat(64);

function run(
  samples: TrainingSample[],
  over: Partial<TrainArgs> = {},
  mode: 'production' | 'research' = 'production',
): TrainResult {
  return api.trainUserModel(trainArgs(samples, over), { mode });
}

function upgradeOf(r: TrainResult): UpgradeMetrics {
  const u = r.metrics.upgrade;
  if (u === null || u === undefined) throw new Error('the upgrade guard was not evaluated');
  return u;
}

/** Whether the guard was not evaluated and left no reason. */
function expectNotEvaluated(r: TrainResult): void {
  expect(r.metrics.upgrade).toBeNull();
  expect(r.activation.reasons).not.toContain('upgrade_regression');
}

function expectJsonSafe(value: unknown): void {
  if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
  else if (Array.isArray(value)) value.forEach(expectJsonSafe);
  else if (typeof value === 'object' && value !== null)
    Object.values(value).forEach(expectJsonSafe);
}

describe('upgrade guard: decisive drift', () => {
  const result = run(driftFixture('drift-a'));

  it('flags a model that is significantly worse than the cards on the newest ratings', () => {
    const u = upgradeOf(result);
    expect(u.ratingSha).toBe(RATING_SHA);
    expect(u.n).toBe(30);
    expect(u.nPos).toBe(15);
    expect(u.nNeg).toBe(15);
    expect(u.regressed).toBe(true);
    expect(u.deltaCi).not.toBeNull();
    expect((u.deltaCi as [number, number])[1]).toBeLessThan(-0.02);
    expect(u.cvAuc as number).toBeLessThan(u.baselineAuc as number);
    expect(u.cvAuc as number).toBeLessThan(0.5);
  });

  it('adds the reason and makes the candidate ineligible', () => {
    expect(result.activation.reasons).toContain('upgrade_regression');
    expect(result.activation.eligible).toBe(false);
    expect(new Set(result.activation.reasons).size).toBe(result.activation.reasons.length);
  });

  it('is robust across seeds (not a borderline fixture)', () => {
    for (const seed of ['drift-b', 'drift-c', 'drift-d']) {
      const r = run(driftFixture(seed));
      expect(upgradeOf(r).regressed).toBe(true);
      expect(r.activation.reasons).toContain('upgrade_regression');
    }
  });

  it('keeps the whole-set quality metrics untouched by the guard', () => {
    expect(result.metrics.nExplicit).toBe(430);
    expect(result.metrics.cvAuc).not.toBeNull();
    expect(result.metrics.cvAuc as number).toBeGreaterThan(0.7);
  });
});

describe('upgrade guard: healthy control', () => {
  it('evaluates and does not flag a model that keeps up on the newest ratings', () => {
    const r = run(healthyFixture('healthy-a'));
    const u = upgradeOf(r);
    expect(u.n).toBe(40);
    expect(u.regressed).toBe(false);
    expect(r.activation.reasons).not.toContain('upgrade_regression');
    expect(u.cvAuc as number).toBeGreaterThan(u.baselineAuc as number);
  });

  it('evaluates at exactly 30 new rows with exactly 5 of the minority class', () => {
    const r = run(
      driftSamples({
        seed: 'edge-5',
        blocks: [
          block(OTHER_RATING_SHA, 150, 1, 0.3),
          { ...block(RATING_SHA, 30, 1, 0.3), nPos: 25 },
        ],
      }),
    );
    const u = upgradeOf(r);
    expect(u.n).toBe(30);
    expect(u.nPos).toBe(25);
    expect(u.nNeg).toBe(5);
  });
});

describe('upgrade guard: not evaluated', () => {
  it('29 new rows are not enough', () => {
    expectNotEvaluated(run(driftFixture('c-29', 400, 29)));
  });

  it('30 new rows with only 4 dislikes are not enough', () => {
    expectNotEvaluated(
      run(
        driftSamples({
          seed: 'c-4',
          blocks: [
            block(OTHER_RATING_SHA, 400, 1, 0),
            { ...block(RATING_SHA, 30, -1, 0.4), nPos: 26 },
          ],
        }),
      ),
    );
  });

  it('30 new rows with only 4 likes are not enough', () => {
    expectNotEvaluated(
      run(
        driftSamples({
          seed: 'c-4b',
          blocks: [
            block(OTHER_RATING_SHA, 400, 1, 0),
            { ...block(RATING_SHA, 30, -1, 0.4), nPos: 4 },
          ],
        }),
      ),
    );
  });

  it('every eligible row carrying the current sha means nothing changed', () => {
    const samples = driftSamples({
      seed: 'c-noold',
      blocks: [block(RATING_SHA, 400, 1, 0), block(RATING_SHA, 40, -1, 0.4)],
    });
    expectNotEvaluated(run(samples));
  });

  it('old rows without a single new row', () => {
    const r = run(
      driftSamples({ seed: 'c-nonew', blocks: [block(OTHER_RATING_SHA, 200, 1, 0.3)] }),
    );
    expect(r.metrics.nExplicit).toBe(200);
    expectNotEvaluated(r);
  });

  it('research mode never evaluates the guard', () => {
    const r = run(driftFixture('drift-a'), {}, 'research');
    expect(r.metrics.research).toBe(true);
    expectNotEvaluated(r);
    expect(r.activation.reasons).toEqual(['research']);
  });

  it('a null rating sha never evaluates the guard', () => {
    const r = run(driftFixture('drift-a'), { ratingSha: null } as Partial<TrainArgs>);
    expect(r.metrics.nExplicit).toBe(430);
    expectNotEvaluated(r);
  });

  it('rows skipped by eligibility (unregistered sha) count as neither old nor new', () => {
    const samples = driftSamples({
      seed: 'c-unreg',
      blocks: [block(RATING_SHA, 200, 1, 0.3), block(UNREGISTERED_SHA, 60, -1, 0.4)],
    });
    const r = run(samples);
    expect(r.metrics.skipped['rating_sha_mismatch']).toBe(60);
    expect(r.metrics.nExplicit).toBe(200);
    expectNotEvaluated(r);
  });

  it('unregistered rows do not stand in for the new rows either', () => {
    const samples = driftSamples({
      seed: 'c-unreg2',
      blocks: [
        block(OTHER_RATING_SHA, 200, 1, 0.3),
        block(RATING_SHA, 29, -1, 0.4),
        block(UNREGISTERED_SHA, 40, -1, 0.4),
      ],
    });
    const r = run(samples);
    expect(r.metrics.skipped['rating_sha_mismatch']).toBe(40);
    expectNotEvaluated(r);
  });
});

describe('upgrade guard: significance gate', () => {
  /**
   * Hard-coded from a seed search: the point estimate of model minus cards on the 40 new rows is
   * about -0.05 (below -maxBaselineDrop), but the 95 % interval reaches +0.08, so a noisy point
   * estimate alone must not trip the guard.
   */
  const samples = driftSamples({
    seed: 'ci-102',
    blocks: [block(OTHER_RATING_SHA, 150, 1, 0.3), block(RATING_SHA, 40, 0, 0.5)],
  });

  it('a point estimate below the drop with an interval reaching above it does not trip', () => {
    const r = run(samples);
    const u = upgradeOf(r);
    expect(u.n).toBe(40);
    expect((u.cvAuc as number) - (u.baselineAuc as number)).toBeLessThan(
      -CFG.model.maxBaselineDrop,
    );
    expect((u.deltaCi as [number, number])[1]).toBeGreaterThanOrEqual(-CFG.model.maxBaselineDrop);
    expect(u.regressed).toBe(false);
    expect(r.activation.reasons).not.toContain('upgrade_regression');
  });
});

describe('upgrade guard: quality reasons combine', () => {
  it('lists upgrade_regression next to the other rejection reasons', () => {
    const config = { ...CFG, model: { ...CFG.model, minCvAuc: 0.99 } };
    const r = run(driftFixture('drift-a'), { config });
    expect(r.activation.eligible).toBe(false);
    expect(r.activation.reasons).toContain('low_auc');
    expect(r.activation.reasons).toContain('upgrade_regression');
    expect(new Set(r.activation.reasons).size).toBe(r.activation.reasons.length);
  });
});

describe('upgrade guard: determinism and JSON safety', () => {
  it('two runs give identical metrics and the upgrade survives a JSON round trip', () => {
    const a = run(driftFixture('drift-a'));
    const b = run(driftFixture('drift-a'));
    expect(a.metrics).toEqual(b.metrics);
    const u = upgradeOf(a);
    expect(JSON.parse(JSON.stringify(u))).toEqual(u);
    expectJsonSafe(u);
    expect(Array.isArray(u.deltaCi)).toBe(true);
    expect((u.deltaCi as number[]).length).toBe(2);
    expect(typeof u.regressed).toBe('boolean');
  });

  it('another seed material still flags the decisive drift', () => {
    const a = upgradeOf(run(driftFixture('drift-a'), { seedMaterial: 'user-1|ctx|cutoff-1' }));
    const b = upgradeOf(run(driftFixture('drift-a'), { seedMaterial: 'user-2|ctx|cutoff-1' }));
    expect(b.regressed).toBe(true);
    expect(a.n).toBe(b.n);
  });
});

describe('upgrade guard: mask alignment', () => {
  function mixed(seed: string): TrainingSample[] {
    return driftSamples({
      seed,
      shareGroups: true,
      blocks: [
        block(OTHER_RATING_SHA, 160, 1, 0.3),
        { ...block(OTHER_RATING_SHA, 40, 1, 0.3), explicit: false },
        block(RATING_SHA, 52, -1, 0.4),
        { ...block(RATING_SHA, 24, -1, 0.4), explicit: false },
      ],
    });
  }

  const cardAuc = (rows: TrainingSample[]): number | null =>
    auc(
      rows.map((s) =>
        Math.min(
          Math.max(
            snapshotCardScore(s.features as NonNullable<typeof s.features>, CFG.strengthWeights) ??
              0,
            1e-6,
          ),
          1 - 1e-6,
        ),
      ),
      rows.map((s) => s.y),
    );

  it('counts exactly the explicit new rows, whatever the fold assignment', () => {
    for (const [seed, seedMaterial] of [
      ['mix-a', 'u|ctx|1'],
      ['mix-a', 'u|ctx|2'],
      ['mix-b', 'u|ctx|3'],
      ['mix-c', 'u|ctx|4'],
    ] as const) {
      const samples = mixed(seed);
      const fresh = samples.filter((s) => s.explicit && s.features?.ratingSha === RATING_SHA);
      const r = run(samples, { seedMaterial });
      const u = upgradeOf(r);
      expect(u.n).toBe(fresh.length);
      expect(u.nPos).toBe(fresh.filter((s) => s.y === 1).length);
      expect(u.nNeg).toBe(fresh.filter((s) => s.y === 0).length);
      expect(r.metrics.nExplicit).toBe(212);
      expect(samples.slice(0, 40).some((s) => s.features?.ratingSha === RATING_SHA)).toBe(true);
      expect(samples.slice(0, 40).some((s) => s.features?.ratingSha === OTHER_RATING_SHA)).toBe(
        true,
      );
    }
  });

  it('pairs each new row with its own cards-only score and label', () => {
    for (const seedMaterial of ['u|ctx|1', 'u|ctx|2', 'u|ctx|3']) {
      const samples = mixed('mix-a');
      const fresh = samples.filter((s) => s.explicit && s.features?.ratingSha === RATING_SHA);
      const u = upgradeOf(run(samples, { seedMaterial }));
      expect(u.baselineAuc).not.toBeNull();
      expect(u.baselineAuc as number).toBeCloseTo(cardAuc(fresh) as number, 10);
    }
  });

  it('covers the whole pooled set when the only old rows are implicit', () => {
    const samples = driftSamples({
      seed: 'mix-implicit',
      blocks: [
        { ...block(OTHER_RATING_SHA, 60, 1, 0.3), explicit: false },
        block(RATING_SHA, 120, 1, 0.3),
      ],
    });
    const r = run(samples);
    const u = upgradeOf(r);
    expect(u.n).toBe(r.metrics.nExplicit);
    expect(u.cvAuc).toBe(r.metrics.cvAuc);
    expect(u.baselineAuc).toBe(r.metrics.baselineAuc);
  });
});

describe('upgrade guard: strict emulation', () => {
  it('with no registered family only the current sha is eligible and nothing is evaluated', () => {
    const r = run(driftFixture('drift-a'), { families: {} });
    expect(r.metrics.skipped['rating_sha_mismatch']).toBe(400);
    expect(r.metrics.nExplicit).toBe(30);
    expectNotEvaluated(r);
  });
});
