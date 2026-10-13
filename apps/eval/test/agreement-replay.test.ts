import { mergeRankerConfig } from '@bantoozi/ranker';
import { describe, expect, it } from 'vitest';

import { replayAgreement } from '../src/agreement-replay/replay.js';
import { renderAgreementReport } from '../src/agreement-replay/render.js';
import { learningArticle, type LearningArticle } from '../src/learning-curve/samples.js';
import { parseRunData } from '../src/report/run-data.js';
import { buildCurveFixture, type CurveFixtureOptions } from './learning-curve-fixtures.js';

const CONFIG = mergeRankerConfig({});

function replayOf(
  options: CurveFixtureOptions,
  feedsOf?: (index: number) => string[],
  noisy?: (articleId: string) => boolean,
) {
  const fixture = buildCurveFixture({ devArticles: 40, testArticles: 20, ...options });
  if (feedsOf !== undefined) {
    fixture.sampleRows.forEach((row, i) => {
      row.snapshot.carrierFeeds = feedsOf(i).map((feedId) => ({ feedId, title: null }));
    });
  }
  if (noisy !== undefined) {
    let k = 0;
    for (const answer of fixture.answers) {
      if (answer.questionKey === 'card' && noisy(answer.articleId)) {
        k += 1;
        (answer.answer as { p: number }).p = ((k * 0.6180339887) % 1) + 0;
      }
    }
  }
  const run = parseRunData(fixture.run, fixture.answers);
  const articles = new Map<string, LearningArticle>(
    fixture.sampleRows.map((row) => [row.articleId, learningArticle(row)]),
  );
  return {
    fixture,
    articles,
    replay: replayAgreement({ run, articles, config: CONFIG, seedBase: 't' }),
  };
}

describe('agreement replay', () => {
  it('keeps every carrier feed on a parsed article', () => {
    const { articles } = replayOf({ raters: 1 });
    expect([...articles.values()][0]?.carrierFeedIds).toEqual(['7', '12']);
  });

  it('marks a feed whose cards separate ready early with no false alarm', () => {
    const { replay } = replayOf({ cards: 'perfect', raters: 1 });
    const feeds = replay.raters[0]?.feeds ?? [];
    expect(feeds.map((f) => f.feedId)).toEqual(['7', '12']);
    for (const feed of feeds) {
      expect(feed.firstReadyAt).not.toBeNull();
      expect(feed.firstReadyAt as number).toBeLessThanOrEqual(30);
      expect(feed.falseAlarm).toBe(false);
      expect(feed.later?.n).toBe(feed.ratings - (feed.firstReadyAt as number));
    }
  });

  it('counts a multi-carrier article for both feeds', () => {
    const { replay, fixture } = replayOf({ cards: 'perfect', raters: 1 });
    const feeds = replay.raters[0]?.feeds ?? [];
    const rated = fixture.ratings.filter((r) => r.raterId === '1').length;
    expect(feeds.map((f) => f.ratings)).toEqual([rated, rated]);
  });

  it('never marks a noise feed ready', () => {
    const { replay } = replayOf({ cards: 'weak', raters: 1 });
    for (const feed of replay.raters[0]?.feeds ?? []) {
      expect(feed.firstReadyAt).toBeNull();
      expect(feed.falseAlarm).toBeNull();
      expect(feed.finalStatus).not.toBe('ready');
    }
  });

  it('separates feeds: one agreeing, one noise', () => {
    const feedOf = (i: number): string[] => (i % 2 === 0 ? ['30'] : ['40']);
    const { replay } = replayOf(
      { cards: 'perfect', raters: 1 },
      feedOf,
      (id) => (Number(id) - 2000) % 2 === 1,
    );
    const feeds = new Map((replay.raters[0]?.feeds ?? []).map((f) => [f.feedId, f]));
    expect(feeds.get('30')?.firstReadyAt).not.toBeNull();
    expect(feeds.get('40')?.firstReadyAt).toBeNull();
  });

  it('is deterministic and renders a report', () => {
    const a = replayOf({ cards: 'perfect' }).replay;
    const b = replayOf({ cards: 'perfect' }).replay;
    expect(b).toEqual(a);
    const text = renderAgreementReport({
      datasetVersion: 'golden-v3',
      runId: '34',
      experiment: 'E1',
      date: '2026-10-13',
      replay: a,
    });
    expect(text).toContain('| feed |');
    expect(text).toContain('Feeds ready');
  });
});
