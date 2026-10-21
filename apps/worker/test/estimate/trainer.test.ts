import { seededRandom, trainEstimateModel, type EstimateSample } from '@bantoozi/ranker';
import { afterAll, describe, expect, it } from 'vitest';

import { CpuPool } from '../../src/cpu-pool.js';
import { inlineEstimateTrainer, poolEstimateTrainer } from '../../src/estimate/trainer.js';

// Under Vitest the pool threads run from the TypeScript sources and register tsx themselves.
const pool = new CpuPool({ size: 2, execArgv: ['--conditions=bantoozi-source'] });

afterAll(async () => {
  await pool.close();
});

const NOW = new Date('2026-10-16T12:00:00Z');
const LIKE = ['rocket', 'orbit', 'satellite', 'launch', 'telescope', 'mission'];
const DISLIKE = ['gossip', 'scandal', 'rumor', 'celebrity', 'divorce', 'feud'];

/** Ratings whose words follow the class, with a little noise. */
function samples(n: number): EstimateSample[] {
  const r = seededRandom('estimate-pool');
  return Array.from({ length: n }, (_, i) => {
    const liked = r() > 0.4 ? i % 2 === 0 : i % 2 === 1;
    const words = liked ? LIKE : DISLIKE;
    const word = (k: number) => words[(i + k) % words.length] as string;
    return {
      articleId: String(1000 + i),
      rating: liked ? 1 : -1,
      ratedAt: new Date(NOW.getTime() - (i + 1) * 3_600_000),
      title: `${word(0)} ${word(1)} report ${i}`,
      excerpt: `${word(2)} ${word(3)} coverage of story ${i}`,
      feedId: String(1 + (i % 3)),
    };
  });
}

describe('inlineEstimateTrainer', () => {
  it('returns what trainEstimateModel returns', async () => {
    const input = samples(40);
    expect(await inlineEstimateTrainer(input, {})).toEqual(trainEstimateModel(input, {}));
    expect(await inlineEstimateTrainer(input, { epochs: 3 })).toEqual(
      trainEstimateModel(input, { epochs: 3 }),
    );
  });
});

describe('poolEstimateTrainer', () => {
  it('returns the model the inline trainer returns for 40 samples, dates and all', async () => {
    const input = samples(40);
    const inline = await inlineEstimateTrainer(input, {});
    expect(inline.ok).toBe(true);
    const pooled = await poolEstimateTrainer(pool)(input, {});
    expect(pooled).toEqual(inline);
    // A fresh thread compiles the ranker sources (and coverage instruments them) before training.
  }, 60_000);

  it('returns the same model for other options', async () => {
    const input = samples(30);
    const options = { epochs: 3, minRatings: 12, seed: 'other' };
    expect(await poolEstimateTrainer(pool)(input, options)).toEqual(
      await inlineEstimateTrainer(input, options),
    );
  }, 60_000);

  it('returns the below-gate result below the gate', async () => {
    const input = samples(6);
    const pooled = await poolEstimateTrainer(pool)(input, {});
    expect(pooled).toEqual({ ok: false, reason: 'below_gate' });
    expect(pooled).toEqual(await inlineEstimateTrainer(input, {}));
  }, 60_000);
});
