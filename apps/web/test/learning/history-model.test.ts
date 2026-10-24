import { describe, expect, it } from 'vitest';

import {
  buildSeries,
  formatQuality,
  isRough,
  milestones,
  readoutOf,
  yDomain,
} from '../../src/features/learning/history-model.js';
import { makeHistoryItem } from './fixtures.js';

const row = makeHistoryItem;

describe('buildSeries', () => {
  it('keeps a line across a row of the other kind and splits on a same-kind null', () => {
    const series = buildSeries([
      row({ kind: 'estimate', auc: 0.6 }),
      row({ kind: 'model', auc: 0.7, baselineAuc: 0.6 }),
      row({ kind: 'estimate', auc: 0.65 }),
      row({ kind: 'estimate', auc: null }),
      row({ kind: 'estimate', auc: 0.7 }),
      row({ kind: 'model', auc: 0.72, baselineAuc: null }),
    ]);
    const by = Object.fromEntries(series.map((s) => [s.name, s]));

    expect(by.estimate?.runs.map((run) => run.map((p) => p.index))).toEqual([[0, 2], [4]]);
    expect(by.model?.runs.map((run) => run.map((p) => p.index))).toEqual([[1, 5]]);
    expect(by.baseline?.runs.map((run) => run.map((p) => p.index))).toEqual([[1]]);
    expect(by.estimate?.latest).toEqual({ index: 4, value: 0.7 });
  });

  it('leaves out a series without any value, and orders model, estimate, baseline', () => {
    expect(buildSeries([row({ kind: 'estimate', auc: null })])).toEqual([]);
    const names = buildSeries([
      row({ kind: 'estimate', auc: 0.6 }),
      row({ kind: 'model', auc: 0.7, baselineAuc: 0.6 }),
    ]).map((s) => s.name);
    expect(names).toEqual(['model', 'estimate', 'baseline']);
  });
});

describe('yDomain', () => {
  it('is 50% to 100% with a tick every 10%', () => {
    const domain = yDomain([row({ auc: 0.7 }), row({ auc: 0.9 })]);
    expect(domain.min).toBe(0.5);
    expect(domain.ticks).toEqual([0.5, 0.6, 0.7, 0.8, 0.9, 1]);
  });

  it('goes lower only when a value is below 50%', () => {
    const domain = yDomain([row({ auc: 0.43 }), row({ auc: 0.9 })]);
    expect(domain.min).toBe(0.4);
    expect(domain.ticks[0]).toBe(0.4);
  });
});

describe('milestones', () => {
  it('claims a turn-on only for a row marked turnedOn', () => {
    expect(
      milestones([row({ kind: 'model', auc: 0.7 }), row({ kind: 'model', auc: 0.7 })]),
    ).toEqual([]);
    expect(
      milestones([
        row({ kind: 'estimate', turnedOn: true }),
        row({ kind: 'model', turnedOn: true, engineModel: 'a' }),
      ]),
    ).toEqual([
      { index: 0, kind: 'estimatesOn' },
      { index: 1, kind: 'modelOn' },
    ]);
  });

  it('marks an engine change between model rows, ignoring estimate rows and unknown ids', () => {
    const found = milestones([
      row({ kind: 'model', engineModel: 'jev-1' }),
      row({ kind: 'estimate' }),
      row({ kind: 'model', engineModel: null }),
      row({ kind: 'model', engineModel: 'jev-2' }),
      row({ kind: 'model', engineModel: 'jev-2' }),
    ]);
    expect(found).toEqual([{ index: 3, kind: 'updated' }]);
    expect(JSON.stringify(found)).not.toContain('jev');
  });
});

describe('rows', () => {
  it('flags a plotted row with fewer than 30 ratings as rough', () => {
    expect(isRough(row({ n: 29, auc: 0.6 }))).toBe(true);
    expect(isRough(row({ n: 30, auc: 0.6 }))).toBe(false);
    expect(isRough(row({ n: 5, auc: null }))).toBe(false);
  });

  it('reads interests alone and the switch only from a model row', () => {
    expect(readoutOf(row({ kind: 'estimate', baselineAuc: 0.5, activated: true }))).toMatchObject({
      interestsAlone: null,
      switchedOn: null,
    });
    expect(readoutOf(row({ kind: 'model', baselineAuc: 0.5, activated: false }))).toMatchObject({
      interestsAlone: 0.5,
      switchedOn: false,
    });
  });

  it('formats a quality as a percent in the language, and a missing one as a dash', () => {
    expect(formatQuality(0.714, 'en')).toBe('71%');
    expect(formatQuality(0.714, 'sk')).toBe('71 %');
    expect(formatQuality(null, 'en')).toBe('–');
  });
});
