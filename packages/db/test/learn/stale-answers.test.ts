import { describe, expect, it } from 'vitest';

import { reduceArticle } from '../../src/learn/reduce.js';
import type { LearnAnalysisResult, LearnEvent } from '../../src/learn/types.js';
import { snapshot } from './fixtures.js';

const at = new Date('2026-10-24T12:00:00Z');
const sha = 'a'.repeat(64);
function reduced(model: string, features: ReturnType<typeof snapshot> | null) {
  const event: LearnEvent = {
    id: '1',
    articleId: '10',
    kind: 'rate',
    createdAt: at,
    value: {
      rating: 1,
      features,
      analysisRequestId: 'request',
      inputSha: 'input',
      ratingSha: sha,
      analysisRatingSha: sha,
      analysisRatingModel: 'jev-1.14.0',
    },
  };
  const result = Object.assign(
    {
      inputSha: 'input',
      facets: { topic: 0.5 },
      cardP: new Map([['501', 0.8]]),
      frozen: {
        feedId: '2',
        cards: [{ id: '501', strength: 'love' }],
        article: {
          wordCount: 100,
          lang: 'en',
          author: null,
          firstSeenAt: at,
          publishedAt: null,
          hasImage: false,
          hasVideo: false,
          bodyImageCount: 0,
          storyClusterId: null,
          clusterSize: 0,
        },
      },
    } satisfies LearnAnalysisResult,
    { model },
  );
  return reduceArticle({
    articleId: '10',
    state: { rating: 1, ratedAt: at, bookmarkedAt: null, readAt: null },
    events: [event],
    prefs: { implicitFeedback: false, implicitNegative: false },
    analysis: new Map([['request', result]]),
  });
}

describe('selected analysis snapshot completion', () => {
  it('marks a derived snapshot answered by an older release than the rating pin', () => {
    expect(reduced('jev-1.13.0', null)?.features).toMatchObject({ staleAnswers: true });
  });
  it('refreshes a complete stale snapshot from the linked current-model result and clears its marker', () => {
    const features = Object.assign(
      snapshot({
        cards: [{ id: '99', strength: 'love', p: 0.2, engine: 'typesafe' }],
        values: { facets: { old: 0.1 }, facetsEngine: 'typesafe', clusterId: null },
      }),
      { ratingSha: sha, staleAnswers: true },
    );
    const refreshed = reduced('jev-1.14.0', features)?.features;
    expect(refreshed?.cards).toEqual([{ id: '501', strength: 'love', p: 0.8, engine: 'typesafe' }]);
    expect(Reflect.get(refreshed!, 'staleAnswers')).not.toBe(true);
    expect(refreshed?.values.facets).toEqual({ topic: 0.5 });
  });
  it('keeps the marker if the linked result also used the older release', () => {
    const features = Object.assign(
      snapshot({
        cards: [{ id: '99', strength: 'love', p: 0.2, engine: 'typesafe' }],
        values: { facets: { old: 0.1 }, facetsEngine: 'typesafe', clusterId: null },
      }),
      { ratingSha: sha, staleAnswers: true },
    );
    expect(reduced('jev-1.13.0', features)?.features).toMatchObject({ staleAnswers: true });
  });
});
