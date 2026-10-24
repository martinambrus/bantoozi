import { DEFAULT_RANKER_CONFIG, eligibleSetSha, eligibilityOf } from '@bantoozi/ranker';
import { afterAll, describe, expect, it } from 'vitest';

import { CpuPool } from '../../src/cpu-pool.js';
import { inlineTrainer, poolTrainer } from '../../src/learn/trainer.js';
import {
  block,
  driftRows,
  trainingSamples,
  type CardSpec,
  type DriftBlock,
} from '../support/guard-drift.js';

/**
 * JEV-4 T3: the upgrade guard's result crosses the CPU pool unchanged. Two exact shas of one
 * family, the older one dominating; `finishTraining` runs on a pool thread and must return what
 * the calling thread returns, `metrics.upgrade` included.
 */

const pool = new CpuPool({ size: 3, execArgv: ['--conditions=bantoozi-source'] });

afterAll(async () => {
  await pool.close();
});

const NOW = new Date('2026-10-16T12:00:00Z');
const OLD = '9'.repeat(64);
const NEW = 'a'.repeat(64);
const FAMILY = 'f'.repeat(64);
const CARDS: CardSpec[] = [
  { id: '101', strength: 'love', from: 'pA' },
  { id: '102', strength: 'like', from: 'pB' },
  { id: '103', strength: 'love', from: 'pC' },
  { id: '104', strength: 'never', from: 'pN' },
];
const HELD = [
  { cardId: '101', strength: 'love', scopeFeedId: null, cardInputSha256: 'h-a' },
  { cardId: '102', strength: 'like', scopeFeedId: null, cardInputSha256: 'h-b' },
  { cardId: '103', strength: 'love', scopeFeedId: null, cardInputSha256: 'h-c' },
  { cardId: '104', strength: 'never', scopeFeedId: '7', cardInputSha256: 'h-n' },
];

function args(blocks: DriftBlock[], seed: string, families: Record<string, string>) {
  return {
    samples: trainingSamples(driftRows(seed, blocks, true), NOW, CARDS),
    now: NOW,
    config: DEFAULT_RANKER_CONFIG,
    heldCards: HELD,
    ratingSha: NEW,
    familySha: FAMILY,
    families,
    consent: { implicitFeedback: false, implicitNegative: false },
    seedMaterial: 'user-1|ctx|cutoff-1',
    feedbackCutoffEventId: '6000',
  } as unknown as Parameters<typeof inlineTrainer>[0];
}

const BOTH = { [OLD]: FAMILY, [NEW]: FAMILY };

describe('poolTrainer and the upgrade guard (JEV-4 T3)', () => {
  it('strict training excludes stale rows across the CPU pool with the same skips and eligible-set hash', async () => {
    const input = {
      ...args([block(OLD, 400, 1, 0), block(NEW, 36, -1, 0.4)], 'strict-stale', {}),
      strict: true,
    };
    const current = input.samples.filter((sample) => sample.features?.ratingSha === NEW);
    for (const sample of current.slice(0, 6)) sample.features!.staleAnswers = true;
    const [pooled, inline] = await Promise.all([
      poolTrainer(pool)(input, 'production'),
      inlineTrainer(input, 'production'),
    ]);
    expect(pooled.metrics.nExplicit).toBe(30);
    expect(pooled.metrics.skipped).toEqual({ rating_sha_mismatch: 400, stale_answers: 6 });
    expect(pooled.metrics.eligibleSetSha).toBe(
      eligibleSetSha(current.slice(6), eligibilityOf(input)),
    );
    expect(pooled.metrics.upgrade).toBeNull();
    expect(pooled).toEqual(inline);
  }, 120_000);

  it('a drift that trips the guard: the pooled result equals the inline one, upgrade metrics and reason included', async () => {
    const input = args([block(OLD, 400, 1, 0), block(NEW, 30, -1, 0.4)], 'drift-a', BOTH);
    const [pooled, inline] = await Promise.all([
      poolTrainer(pool)(input, 'production'),
      inlineTrainer(input, 'production'),
    ]);
    expect(inline.metrics.nExplicit).toBe(430);
    const upgrade = (inline.metrics as unknown as { upgrade: Record<string, unknown> | null })
      .upgrade;
    expect(upgrade).not.toBeNull();
    expect(upgrade).toMatchObject({ ratingSha: NEW, n: 30, regressed: true });
    expect(inline.activation.eligible).toBe(false);
    expect(inline.activation.reasons).toContain('upgrade_regression');
    expect(pooled).toEqual(inline);
    expect(pooled.activation.reasons).toContain('upgrade_regression');
    expect(
      (pooled.metrics as unknown as { upgrade: Record<string, unknown> | null }).upgrade,
    ).toEqual(upgrade);
  }, 120_000);

  it('CONTROL: a healthy upgrade is evaluated, not flagged, and crosses the pool unchanged', async () => {
    const input = args([block(OLD, 150, 1, 0.3), block(NEW, 40, 1, 0.3)], 'healthy-a', BOTH);
    const [pooled, inline] = await Promise.all([
      poolTrainer(pool)(input, 'production'),
      inlineTrainer(input, 'production'),
    ]);
    const upgrade = (inline.metrics as unknown as { upgrade: Record<string, unknown> | null })
      .upgrade;
    expect(upgrade).not.toBeNull();
    expect(upgrade).toMatchObject({ ratingSha: NEW, n: 40, regressed: false });
    expect(inline.activation.reasons).not.toContain('upgrade_regression');
    expect(pooled).toEqual(inline);
  }, 120_000);

  it('CONTROL: a single exact sha never evaluates the guard, inline or pooled', async () => {
    const input = args([block(NEW, 120, 1, 0.3)], 'single-a', { [NEW]: FAMILY });
    const [pooled, inline] = await Promise.all([
      poolTrainer(pool)(input, 'production'),
      inlineTrainer(input, 'production'),
    ]);
    expect((inline.metrics as unknown as { upgrade: unknown }).upgrade).toBeNull();
    expect(inline.activation.reasons).not.toContain('upgrade_regression');
    expect(pooled).toEqual(inline);
  }, 120_000);

  it('CONTROL: strict input (only the current sha eligible) never evaluates the guard', async () => {
    const input = args([block(OLD, 400, 1, 0), block(NEW, 36, -1, 0.4)], 'strict-a', {});
    const [pooled, inline] = await Promise.all([
      poolTrainer(pool)(input, 'production'),
      inlineTrainer(input, 'production'),
    ]);
    expect(inline.metrics.nExplicit).toBe(36);
    expect(inline.metrics.skipped).toEqual({ rating_sha_mismatch: 400 });
    expect((inline.metrics as unknown as { upgrade: unknown }).upgrade).toBeNull();
    expect(inline.activation.reasons).not.toContain('upgrade_regression');
    expect(pooled).toEqual(inline);
  }, 120_000);
});
