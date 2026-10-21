import { describe, expect, it } from 'vitest';

import { api } from './support/api.js';
import type { TrainResult } from './support/api.js';
import { driftFixture } from './support/drift.js';
import { CFG, trainArgs } from './support/synth.js';

const withDrop = (maxBaselineDrop: number) => ({
  ...CFG,
  model: { ...CFG.model, maxBaselineDrop },
});

function run(maxBaselineDrop: number): TrainResult {
  return api.trainUserModel(
    trainArgs(driftFixture('drift-a'), { config: withDrop(maxBaselineDrop) }),
    {
      mode: 'production',
    },
  );
}

describe('upgrade guard: the margin is model.maxBaselineDrop', () => {
  it('trips on the decisive drift at the default margin and at none', () => {
    expect(run(CFG.model.maxBaselineDrop).metrics.upgrade?.regressed).toBe(true);
    expect(run(0).metrics.upgrade?.regressed).toBe(true);
  });

  it('does not trip when the configured margin is wider than the significant gap', () => {
    const u = run(0.9).metrics.upgrade;
    expect(u).not.toBeNull();
    expect(u?.deltaCi).not.toBeNull();
    expect(u?.regressed).toBe(false);
    expect(run(0.9).activation.reasons).not.toContain('upgrade_regression');
  });

  it('follows the margin exactly: tripped iff the interval upper bound is below minus the margin', () => {
    const upper = (run(CFG.model.maxBaselineDrop).metrics.upgrade?.deltaCi as [number, number])[1];
    expect(upper).toBeLessThan(-CFG.model.maxBaselineDrop);
    expect(run(Math.abs(upper) - 0.01).metrics.upgrade?.regressed).toBe(true);
    expect(run(Math.abs(upper) + 0.01).metrics.upgrade?.regressed).toBe(false);
  });
});
