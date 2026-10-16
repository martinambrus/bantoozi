import { DEFAULT_RANKER_CONFIG } from '@bantoozi/ranker';
import { describe, expect, it } from 'vitest';

import { inlineTrainer, threadTrainer } from '../../src/learn/train-thread.js';

const ARGS = {
  samples: [],
  now: new Date('2026-10-16T12:00:00Z'),
  config: DEFAULT_RANKER_CONFIG,
  heldCards: [],
  ratingSha: 'a'.repeat(64),
  consent: { implicitFeedback: false, implicitNegative: false },
  seedMaterial: 'user-1|ctx|cutoff-1',
  feedbackCutoffEventId: '1',
};

describe('threadTrainer (D-259)', () => {
  it('returns what training on the calling thread returns', async () => {
    // Under Vitest the thread runs from the TypeScript sources and registers tsx itself.
    const trainer = threadTrainer({ execArgv: ['--conditions=bantoozi-source'] });
    const [threaded, inline] = await Promise.all([
      trainer(ARGS, 'production'),
      inlineTrainer(ARGS, 'production'),
    ]);
    expect(threaded).toEqual(inline);
  });
});
