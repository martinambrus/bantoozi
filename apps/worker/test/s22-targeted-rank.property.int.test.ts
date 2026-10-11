import { appendFileSync } from 'node:fs';

import fc from 'fast-check';
import { afterAll, beforeAll, describe, it } from 'vitest';

import { ClassifyHarness, DAY, MINUTE } from './support/classify.js';
import { RankWorld, type FlagKind, type Step, type WorldSpec } from './support/s22-world.js';

/**
 * S22 property test (findings §Property test): random sequences of reader actions (and clock jumps
 * and arrivals) over a small world of two story clusters. After EVERY step the drained stored
 * ranking is compared with a full-rank oracle (see `RankWorld.compareToOracle`), and the revision
 * and full-intent counters may only move when a step flipped an auto demotion flag.
 *
 * `S22_SEED` overrides the seed; `S22_RUNS` the run count; `S22_CALIBRATE=1` disables ONLY the
 * "no bump / no full intent" assertions (used once to show the oracle comparison itself holds on
 * the code that still bumps).
 */

const SEED = Number(process.env['S22_SEED'] ?? 20261011);
const RUNS = Number(process.env['S22_RUNS'] ?? 200);
const BUMP_CHECKS = process.env['S22_CALIBRATE'] !== '1';

let h: ClassifyHarness;
const tally = new Map<string, number>();

beforeAll(async () => {
  h = await ClassifyHarness.start();
});

afterAll(async () => {
  await h?.close();
});

const prob = fc.integer({ min: 5, max: 95 }).map((n) => n / 100);
const flag: fc.Arbitrary<FlagKind> = fc.constantFrom<FlagKind>(
  'none',
  'none',
  'none',
  'clickbait',
  'promo',
  'shallow',
  'stale',
);
const specArb: fc.Arbitrary<WorldSpec> = fc.record({
  p: fc.array(prob, { minLength: 6, maxLength: 6 }),
  labelP: fc.array(fc.constantFrom(0.3, 0.9), { minLength: 6, maxLength: 6 }),
  flags: fc.array(flag, { minLength: 6, maxLength: 6 }),
  markReadOnRate: fc.boolean(),
  rankedInitially: fc.boolean(),
});

const idx = fc.nat(7);
const reason = fc.constantFrom('off_topic', 'clickbait', 'seen', 'shallow', 'promo', 'other', null);
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ k: fc.constant('read' as const), a: idx }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('open' as const), a: idx }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('unread' as const), a: idx }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('unhide' as const), a: idx }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('bookmark' as const), a: idx }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('label' as const), a: idx }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('unlabel' as const), a: idx }) },
  {
    weight: 5,
    arbitrary: fc.record({
      k: fc.constant('rate' as const),
      a: idx,
      rating: fc.constantFrom<1 | -1 | null>(1, -1, -1, null),
      reason,
      hide: fc.boolean(),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ k: fc.constant('prompt' as const), a: idx, liked: fc.boolean() }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      k: fc.constant('rateBulk' as const),
      as: fc.array(idx, { minLength: 1, maxLength: 4 }),
      rating: fc.constantFrom<1 | -1 | null>(1, -1, null),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      k: fc.constant('markRead' as const),
      as: fc.array(idx, { minLength: 1, maxLength: 4 }),
    }),
  },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('undo' as const) }) },
  {
    weight: 1,
    arbitrary: fc.record({
      k: fc.constant('jump' as const),
      ms: fc.constantFrom(7 * DAY, 14 * DAY + MINUTE, 90 * DAY),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      k: fc.constant('arrive' as const),
      cluster: fc.constantFrom<0 | 1 | null>(0, 1, null),
      p: prob,
      flag,
    }),
  },
);

describe('S22 targeted re-rank equals a full rank', () => {
  it(
    'after every step, the drained ranking equals the oracle (seed printed)',
    async () => {
      console.log(`S22 property seed=${SEED} runs=${RUNS} bumpChecks=${BUMP_CHECKS}`);
      await fc.assert(
        fc.asyncProperty(
          specArb,
          fc.array(stepArb, { minLength: 1, maxLength: 9 }),
          async (spec, steps) => {
            const world = await RankWorld.create(h, spec);
            try {
              for (const [n, step] of steps.entries()) {
                // Calibration only: today `unlabel` re-ranks nothing (a known baseline gap the design closes).
                if (!BUMP_CHECKS && step.k === 'unlabel') continue;
                const label = `step ${n} ${JSON.stringify(step)}`;
                const before = await world.counters();
                const executed = await world.perform(step);
                const key = `${step.k}:${executed ? 'ran' : 'noop'}`;
                tally.set(key, (tally.get(key) ?? 0) + 1);
                const after = await world.counters();
                // The flag set is judged at the step's own clock, before and after the action.
                const flipped =
                  step.k !== 'jump' && step.k !== 'arrive' && before.flags !== after.flags;
                if (BUMP_CHECKS && !flipped) {
                  if (after.rankRevision !== before.rankRevision) {
                    throw new Error(
                      `${label}: rank_revision ${before.rankRevision} -> ${after.rankRevision} without a demotion flip (executed=${executed})`,
                    );
                  }
                  if (after.fullIntents !== before.fullIntents) {
                    throw new Error(
                      `${label}: ${after.fullIntents - before.fullIntents} full user.rank intent(s) without a demotion flip`,
                    );
                  }
                }
                const ran = await world.drain();
                // A step that triggered no run at all leaves never-ranked articles unranked.
                const noRun = ran === 0 && step.k !== 'jump' && step.k !== 'arrive';
                const diff = await world.compareToOracle(noRun);
                if (diff !== null)
                  throw new Error(
                    `${label}: stored ranking differs from the full-rank oracle\n${diff}`,
                  );
              }
            } catch (error) {
              const log = process.env['S22_FAILLOG'];
              if (log !== undefined) appendFileSync(log, `${String(error)}\n---\n`);
              throw error;
            } finally {
              await world.close();
            }
          },
        ),
        { numRuns: RUNS, seed: SEED, endOnFailure: false },
      );
      console.log(`S22 steps ${JSON.stringify([...tally].sort())}`);
      const out = process.env['S22_FAILLOG'];
      if (out !== undefined) appendFileSync(out, `TALLY ${JSON.stringify([...tally].sort())}\n`);
    },
    60 * 60_000,
  );
});
