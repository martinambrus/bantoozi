import {
  DEFAULT_RANKER_CONFIG,
  FEATURE_SPEC_V1_FACET_NAMES,
  RAW_SNAPSHOT_SPEC_SHA,
  seededRandom,
} from '@bantoozi/ranker';
import { afterAll, describe, expect, it } from 'vitest';

import { CpuPool, cpuPoolSize, share } from '../../src/cpu-pool.js';
import { inlineTrainer, poolTrainer } from '../../src/learn/trainer.js';

// Under Vitest the pool threads run from the TypeScript sources and register tsx themselves.
const pool = new CpuPool({ size: 3, execArgv: ['--conditions=bantoozi-source'] });

afterAll(async () => {
  await pool.close();
});

const NOW = new Date('2026-10-16T12:00:00Z');
const CARD = '101';

/** Explicit ratings whose label follows one interest card's match probability. */
function samples(n: number) {
  const r = seededRandom('pool');
  return Array.from({ length: n }, (_, i) => {
    const p = r();
    const y = p + 0.3 * (r() - 0.5) > 0.5 ? 1 : 0;
    const at = new Date(NOW.getTime() - (i + 1) * 3_600_000).toISOString();
    return {
      articleId: String(1000 + i),
      eventId: String(5000 + i),
      groupId: String(1000 + i),
      y,
      weight: 1,
      explicit: true,
      signal: 'rating',
      reason: null,
      feedbackAt: new Date(at),
      features: {
        specSha: RAW_SNAPSHOT_SPEC_SHA,
        ratingSha: 'a'.repeat(64),
        snapshotAt: at,
        cards: [{ id: CARD, strength: 'love', p, engine: 'typesafe' }],
        values: {
          facets: Object.fromEntries(FEATURE_SPEC_V1_FACET_NAMES.map((name) => [name, 0.1])),
          facetsEngine: 'typesafe',
          wordCount: 300,
          ageHours: 5,
          lang: 'en',
          hasImage: true,
          hasVideo: false,
          bodyImageCount: 1,
          clusterId: null,
          clusterSize: 1,
          sourceFeedId: '7',
          author: null,
        },
      },
    };
  });
}

function args(n: number) {
  return {
    samples: samples(n),
    now: NOW,
    config: DEFAULT_RANKER_CONFIG,
    heldCards: [{ cardId: CARD, strength: 'love', scopeFeedId: null, cardInputSha256: 'h' }],
    ratingSha: 'a'.repeat(64),
    consent: { implicitFeedback: false, implicitNegative: false },
    seedMaterial: 'user-1|ctx|cutoff-1',
    feedbackCutoffEventId: '6000',
  } as unknown as Parameters<typeof inlineTrainer>[0];
}

describe('poolTrainer (D-262)', () => {
  it('returns what training on the calling thread returns, folds in parallel', async () => {
    const input = args(200);
    const [pooled, inline] = await Promise.all([
      poolTrainer(pool)(input, 'production'),
      inlineTrainer(input, 'production'),
    ]);
    expect(pooled.metrics.k).toBeGreaterThan(1);
    expect(pooled.model).not.toBeNull();
    expect(pooled).toEqual(inline);
    // A fresh thread compiles the ranker sources (and coverage instruments them) before training.
  }, 60_000);

  it('rejects without folds as the inline trainer does', async () => {
    const input = args(3);
    expect(await poolTrainer(pool)(input, 'production')).toEqual(
      await inlineTrainer(input, 'production'),
    );
  }, 60_000);

  it('never starts more threads than its size, and fails only the task that throws', async () => {
    const input = args(60);
    const runs = await Promise.allSettled([
      ...Array.from({ length: 4 }, () => poolTrainer(pool)(input, 'production')),
      pool.run({ kind: 'trainFold', args: share(input), mode: 'production', f: 99 }),
      pool.run({ kind: 'trainFold', args: share(input), mode: 'production', f: -1 }),
    ]);
    expect(pool.threads).toBeLessThanOrEqual(3);
    expect(runs.slice(0, 4).every((run) => run.status === 'fulfilled')).toBe(true);
    expect(runs[4]).toMatchObject({ status: 'fulfilled', value: null });
    expect(runs[5]).toMatchObject({ status: 'rejected', reason: { message: 'no outer fold -1' } });
  }, 60_000);
});

describe('cpuPoolSize (D-262)', () => {
  it('keeps max(2, cores/8) cores for the rest of the machine unless overridden', () => {
    expect(cpuPoolSize(1)).toBe(1);
    expect(cpuPoolSize(2)).toBe(1);
    expect(cpuPoolSize(8)).toBe(6);
    expect(cpuPoolSize(16)).toBe(14);
    expect(cpuPoolSize(128)).toBe(112);
    expect(cpuPoolSize(128, 128)).toBe(128);
    expect(cpuPoolSize(8, 0)).toBe(1);
  });
});
