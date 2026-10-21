import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ClassifyHarness } from './support/classify.js';
import {
  V113,
  V114,
  V2,
  begin,
  ensureRegistered,
  exactShaOf,
  flip,
  learnInputs,
  reasonCounts,
} from './support/jev4-world.js';
import { LearnWorld } from './support/learn-world.js';

/**
 * A rating given after a model upgrade but before the rebuild reached its article keeps the answers
 * of the older release of the same Jev major (spec 06 §8.2); another major keeps none.
 */

const RATINGS = 6;

let h: ClassifyHarness;
let w: LearnWorld;

beforeAll(async () => {
  h = await ClassifyHarness.start();
  w = await LearnWorld.create(h);
}, 240_000);

afterAll(async () => {
  await w?.close();
  await h?.close();
});

beforeEach(async () => {
  h.router.reset();
  await h.clearOutbox();
});

async function ratedAfter(pin: string) {
  await begin(h, V113);
  await ensureRegistered(h);
  await flip(h, pin);
  const userId = await w.user({ lastActiveDaysAgo: 0 });
  await w.rateRange(userId, 0, RATINGS);
  return learnInputs(h, userId);
}

describe('ratings captured while the rebuild is still running', () => {
  it('count under the new exact sha when the old answers are of the same Jev major', async () => {
    const inputs = await ratedAfter(V114);
    const exact = await exactShaOf(h);
    expect(reasonCounts(inputs)).toEqual({ ok: RATINGS });
    expect(inputs.samples.map((s) => s.features?.ratingSha)).toEqual(
      Array.from({ length: RATINGS }, () => exact),
    );
  });

  it('CONTROL: stay unusable when the pin moved to another Jev major', async () => {
    const inputs = await ratedAfter(V2);
    expect(reasonCounts(inputs)).toEqual({ no_facets: RATINGS });
  });
});
