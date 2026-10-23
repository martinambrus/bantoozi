import type { LearningFeedEntry, LearningStatus } from '@bantoozi/shared';
import { describe, expect, it } from 'vitest';

import { chipState, type ChipInput } from '../../src/features/learning/chip-state.js';
import {
  makeAgreement,
  makeEstimates,
  makeFeedEstimate,
  makeLearning,
  readyAgreement,
} from './fixtures.js';

const SINCE = '2026-10-17T08:30:00.000Z';

function input(
  feeds: LearningFeedEntry[],
  over: Partial<LearningStatus> = {},
  rest: Partial<Omit<ChipInput, 'learning'>> = {},
): ChipInput {
  return {
    learning: makeLearning({}, feeds, { estimates: makeEstimates({ n: 120, auc: 0.7 }), ...over }),
    feedId: '1',
    inferenceMode: 'training',
    estimatesPreference: 'on',
    ...rest,
  };
}

describe('chipState', () => {
  it('pauses over everything else', () => {
    const classification = { state: 'paused', since: SINCE, reason: 'engine_unavailable' } as const;

    expect(chipState(input([readyAgreement('1')], { classification }))).toEqual({
      kind: 'paused',
      classification,
    });
  });

  it.each([
    ['prefs off', input([], {}, { estimatesPreference: 'off' }), { kind: 'off' }],
    [
      'gate',
      input([], { estimates: null, estimateGate: { needed: 4 } }),
      { kind: 'gate', needed: 4 },
    ],
    ['starting', input([], { estimates: null, estimateGate: { needed: 0 } }), { kind: 'starting' }],
    [
      'on, feed estimate below 30',
      input([makeFeedEstimate('1', 29, 0.9)], {}, { inferenceMode: 'off' }),
      { kind: 'on', ratedHere: 29, total: 120, quality: null },
    ],
    [
      'on, feed estimate at 30',
      input([makeFeedEstimate('1', 30, 0.9)], {}, { inferenceMode: 'off' }),
      { kind: 'on', ratedHere: 30, total: 120, quality: 0.9 },
    ],
    [
      'on, feed estimate without AUC',
      input([makeFeedEstimate('1', 40, null)], {}, { inferenceMode: 'off' }),
      { kind: 'on', ratedHere: 40, total: 120, quality: null },
    ],
    [
      'on, no feed estimate',
      input([], {}, { inferenceMode: 'off' }),
      { kind: 'on', ratedHere: null, total: 120, quality: null },
    ],
    [
      'on, estimate of a training entry',
      input([makeAgreement('1', 'collecting', { estimate: { n: 31, auc: 0.8 } })]),
      { kind: 'on', ratedHere: 31, total: 120, quality: 0.8 },
    ],
  ])('estimate segment: %s', (_name, given, estimate) => {
    expect(chipState(given)).toMatchObject({ kind: 'shown', estimate });
  });

  it.each([
    ['ready', [readyAgreement('1')], 'training', { kind: 'ready' }],
    [
      'not yet with a lower bound',
      [makeAgreement('1', 'not_yet', { aucLow: 0.52 })],
      'training',
      { kind: 'agree', value: 0.52, threshold: 0.6 },
    ],
    ['not yet without one', [makeAgreement('1', 'not_yet')], 'training', { kind: 'weak' }],
    ['collecting', [makeAgreement('1', 'collecting')], 'training', { kind: 'none' }],
    ['one sided', [makeAgreement('1', 'one_sided')], 'training', { kind: 'none' }],
    ['no entry', [], 'training', { kind: 'none' }],
    ['an Off feed with a stale entry', [readyAgreement('1')], 'off', { kind: 'none' }],
    [
      'an Off feed with a not-yet entry',
      [makeAgreement('1', 'not_yet', { aucLow: 0.52 })],
      'off',
      { kind: 'none' },
    ],
    ['another feed', [readyAgreement('2')], 'training', { kind: 'none' }],
  ] as const)('cards segment: %s', (_name, feeds, inferenceMode, cards) => {
    expect(chipState(input([...feeds], {}, { inferenceMode }))).toMatchObject({
      kind: 'shown',
      cards,
    });
  });
});
