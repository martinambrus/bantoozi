import { describe, expect, it } from 'vitest';

import { type CardWorkState, matchCoverage } from '../src/index.js';
import { answers, card, evidence } from './support.js';

describe('matchCoverage (spec 05 §5.5, reader-specific coverage contract)', () => {
  const positives = [card('1', 'must'), card('2', 'love'), card('3', 'like')];

  it('is complete when every applicable positive card has a usable answer', () => {
    expect(matchCoverage(positives, evidence(answers({ '1': 0.1, '2': 0, '3': 1 })))).toEqual({
      coverage: 'complete',
      answered: ['1', '2', '3'],
      pending: [],
      unavailable: [],
    });
  });

  it('is vacuously complete without applicable positive cards', () => {
    expect(matchCoverage([], evidence({})).coverage).toBe('complete');
    expect(matchCoverage([card('9', 'never')], evidence({})).coverage).toBe('complete');
  });

  it('counts a missing answer without known work as pending (scheduled normally)', () => {
    const report = matchCoverage(positives, evidence(answers({ '1': 0.4 })));
    expect(report).toMatchObject({ coverage: 'pending', answered: ['1'], pending: ['2', '3'] });
  });

  it('counts scheduled work as pending', () => {
    const report = matchCoverage(positives, evidence(answers({ '1': 0.4, '2': 0.3 })), {
      '3': 'scheduled',
    });
    expect(report).toMatchObject({ coverage: 'pending', pending: ['3'] });
  });

  it.each<CardWorkState>(['no_key', 'budget', 'circuit_open', 'exhausted'])(
    'counts %s work as unavailable',
    (state) => {
      const report = matchCoverage(positives, evidence(answers({ '1': 0.4, '2': 0.3 })), {
        '3': state,
      });
      expect(report).toMatchObject({ coverage: 'unavailable', unavailable: ['3'], pending: [] });
    },
  );

  it('counts a prefilter marker as unavailable, unless its pair is scheduled again', () => {
    const marked = evidence({
      ...answers({ '1': 0.4, '2': 0.3 }),
      '3': { p: 0, engine: 'prefilter' },
    });
    expect(matchCoverage(positives, marked)).toMatchObject({
      coverage: 'unavailable',
      unavailable: ['3'],
    });
    expect(matchCoverage(positives, marked, { '3': 'scheduled' })).toMatchObject({
      coverage: 'pending',
      pending: ['3'],
    });
  });

  it('stays pending while any card can still be answered, even beside unavailable ones', () => {
    const report = matchCoverage(positives, evidence({}), {
      '1': 'circuit_open',
      '2': 'scheduled',
    });
    expect(report).toEqual({
      coverage: 'pending',
      answered: [],
      pending: ['2', '3'],
      unavailable: ['1'],
    });
  });

  it('is unavailable when nothing missing can progress, answers or not', () => {
    const blocked = { '1': 'budget', '2': 'no_key', '3': 'exhausted' } as const;
    expect(matchCoverage(positives, evidence({}), blocked).coverage).toBe('unavailable');
    expect(matchCoverage(positives, evidence(answers({ '1': 0.9 })), blocked)).toMatchObject({
      coverage: 'unavailable',
      answered: ['1'],
      unavailable: ['2', '3'],
    });
  });

  it('keeps a usable answer answered while its pair is requeued (an LLM answer awaiting Jev)', () => {
    const report = matchCoverage(
      positives,
      evidence(answers({ '1': { p: 0.8, engine: 'llm' }, '2': 0.1, '3': 0.2 })),
      { '1': 'scheduled' },
    );
    expect(report.coverage).toBe('complete');
  });

  it('treats an invalid answer as unknown', () => {
    const report = matchCoverage(
      [card('1', 'love')],
      evidence({ '1': { p: 2, engine: 'typesafe' } }),
    );
    expect(report).toMatchObject({ coverage: 'pending', pending: ['1'] });
  });

  it('ignores never-cards, labels and cards scoped to a carrier that is not authorized', () => {
    const cards = [
      card('1', 'love'),
      card('2', 'never'),
      card('3', 'like', { scopeFeedId: '8' }),
      card('4', 'must', { scopeFeedId: '1' }),
    ];
    // '5' is a label: its answer is in cardAnswers but it is not an interest card.
    const report = matchCoverage(cards, evidence(answers({ '1': 0.2, '4': 0.3, '5': 0.1 }), ['1']));
    expect(report).toEqual({
      coverage: 'complete',
      answered: ['1', '4'],
      pending: [],
      unavailable: [],
    });
  });

  it('lists card ids in numeric order', () => {
    const cards = [card('100', 'love'), card('20', 'love'), card('3', 'love')];
    expect(matchCoverage(cards, evidence({})).pending).toEqual(['3', '20', '100']);
  });
});
