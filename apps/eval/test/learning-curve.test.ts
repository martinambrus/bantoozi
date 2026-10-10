import { mergeRankerConfig } from '@bantoozi/ranker';
import { describe, expect, it } from 'vitest';

import { computeLearningCurve, thresholdRule } from '../src/learning-curve/curve.js';
import { renderCurveReport, renderCurveTable } from '../src/learning-curve/render.js';
import { learningArticle, type LearningArticle } from '../src/learning-curve/samples.js';
import { parseRunData } from '../src/report/run-data.js';
import { buildCurveFixture, type CurveFixtureOptions } from './learning-curve-fixtures.js';

const SIZES = [10, 20, 30, 50, 100];
const CONFIG = mergeRankerConfig({});

function curveOf(options: CurveFixtureOptions = {}) {
  const fixture = buildCurveFixture(options);
  const run = parseRunData(fixture.run, fixture.answers);
  const articles = new Map<string, LearningArticle>(
    fixture.sampleRows.map((row) => [row.articleId, learningArticle(row)]),
  );
  const curve = computeLearningCurve({ run, articles, config: CONFIG, sizes: SIZES });
  return { fixture, articles, curve };
}

describe('learning curve', () => {
  const winning = curveOf({ cards: 'weak', facets: 'informative' });

  it('has a row for every rater and every size, on the same test ratings', () => {
    expect(winning.curve.raters.map((r) => r.raterId)).toEqual(['1', '2']);
    for (const rater of winning.curve.raters) {
      expect(rater.rows.map((r) => r.n)).toEqual(SIZES);
      const expectedTest = winning.fixture.sampleRows
        .filter((row) => row.split === 'test')
        .map((row) => row.articleId)
        .sort();
      expect([...rater.testIds].sort()).toEqual(expectedTest);
      for (const row of rater.rows) {
        expect(row.testIds).toEqual(rater.testIds);
        expect(row.testN).toBe(rater.testIds.length);
        expect(row.testPos + row.testNeg).toBe(row.testN);
        expect(row.testPos).toBe(rater.rows[0]?.testPos);
      }
    }
  });

  it('trains on the first n development ratings in arrival order and never on test groups', () => {
    for (const rater of winning.curve.raters) {
      const dev = winning.fixture.ratings
        .filter(
          (r) => r.raterId === rater.raterId && winning.articles.get(r.articleId)?.split === 'dev',
        )
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
        .map((r) => r.articleId);
      const testGroups = new Set(rater.testIds.map((id) => winning.articles.get(id)?.storyGroupId));
      for (const row of rater.rows) {
        expect(row.trainIds).toEqual(dev.slice(0, row.n));
        for (const id of row.trainIds) {
          expect(winning.articles.get(id)?.split).toBe('dev');
          expect(testGroups.has(winning.articles.get(id)?.storyGroupId)).toBe(false);
        }
      }
    }
  });

  it('marks research mode below the minimums and production above them', () => {
    const rows = winning.curve.raters[0]?.rows ?? [];
    expect(rows.find((r) => r.n === 10)?.mode).toBe('research');
    expect(rows.find((r) => r.n === 10)?.activation).toContain('insufficient_explicit');
    expect(rows.find((r) => r.n === 100)?.mode).toBe('production');
    for (const row of rows) {
      expect(row.modelAuc).not.toBeNull();
      expect(row.cardsAuc).not.toBeNull();
      expect(row.modelLogloss).not.toBeNull();
    }
  });

  it('keeps old ratings trainable: the window ends at the rater last rating, not at the wall clock', () => {
    const old = curveOf({ firstRatingAt: '2023-01-10T08:00:00.000Z' });
    const row = old.curve.raters[0]?.rows.find((r) => r.n === 100);
    expect(row?.mode).toBe('production');
    expect(row?.skipped['too_old'] ?? 0).toBe(0);
  });

  it('proposes a threshold change only when the model loses at n = 50 for more than half', () => {
    const rule = thresholdRule(winning.curve, 50);
    expect(rule).toMatchObject({ n: 50, raters: 2, notBeating: 0, proposalNeeded: false });
    const row = winning.curve.raters[0]?.rows.find((r) => r.n === 50);
    expect(row?.deltaAuc).toBeGreaterThan(0);

    const losing = curveOf({ cards: 'perfect', facets: 'noise' });
    const lost = thresholdRule(losing.curve, 50);
    expect(lost).toMatchObject({ raters: 2, notBeating: 2, proposalNeeded: true });
  });

  it('renders the table and the report with the proposal line only for a losing case', () => {
    const losing = curveOf({ cards: 'perfect', facets: 'noise' });
    const info = { datasetVersion: 'golden-v3', runId: '34', experiment: 'E1', date: '2026-10-10' };
    const table = renderCurveTable(winning.curve);
    for (const header of ['cards AUC', 'model AUC', 'ΔAUC', 'mode', 'own inputs']) {
      expect(table).toContain(header);
    }
    expect(table).toContain('research');
    expect(table).toContain('production');
    const good = renderCurveReport({
      ...info,
      curve: winning.curve,
      rule: thresholdRule(winning.curve, 50),
    });
    expect(good).not.toContain('THRESHOLD CHANGE PROPOSAL NEEDED');
    const bad = renderCurveReport({
      ...info,
      curve: losing.curve,
      rule: thresholdRule(losing.curve, 50),
    });
    expect(bad).toContain('THRESHOLD CHANGE PROPOSAL NEEDED');
    expect(bad).toContain('golden-v3');
  });
});
