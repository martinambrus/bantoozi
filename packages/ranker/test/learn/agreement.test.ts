import { describe, expect, it } from 'vitest';

import {
  eligibleRows,
  FEED_AGREEMENT,
  feedAgreement,
  learningCounts,
  uncoveredSuggests,
  sampleFeedIds,
  trainUserModel,
} from '../../src/index.js';
import type { RawFeatureSnapshot, TrainingSample } from '../../src/index.js';
import { CFG, drivenSamples, NOW, RATING_SHA, sample, trainArgs } from './support/synth.js';

const ELIG = { now: NOW, historyDays: CFG.model.historyDays, ratingSha: RATING_SHA };

function rowsOf(samples: TrainingSample[]) {
  return eligibleRows(samples, ELIG).rows;
}

function withManifest(s: TrainingSample, feedIds: unknown): TrainingSample {
  if (s.features === null) throw new Error('no snapshot');
  const features = { ...s.features, sourceManifest: { inferenceFeedIds: feedIds } };
  return { ...s, features: features as unknown as RawFeatureSnapshot };
}

function withSourceFeed(s: TrainingSample, feedId: string | null): TrainingSample {
  if (s.features === null) throw new Error('no snapshot');
  const features = { ...s.features, values: { ...s.features.values, sourceFeedId: feedId } };
  return { ...s, features };
}

/** Liked samples carry a high card probability, disliked a low one: the cards separate them. */
function separated(likes: number, dislikes: number): TrainingSample[] {
  const out: TrainingSample[] = [];
  for (let i = 0; i < likes; i += 1) out.push(sample(i, 1, { pA: 0.9 - i * 0.01 }));
  for (let i = 0; i < dislikes; i += 1) out.push(sample(100 + i, 0, { pA: 0.1 + i * 0.01 }));
  return out;
}

describe('learningCounts', () => {
  it('matches the trainer metrics on the same samples', () => {
    const samples = drivenSamples(120, 'counts');
    const { metrics } = trainUserModel(trainArgs(samples), { mode: 'research' });
    expect(learningCounts(rowsOf(samples))).toEqual({
      explicit: metrics.nExplicit,
      likes: metrics.nPos,
      dislikes: metrics.nNeg,
    });
    // Trains a whole model: slow under coverage, like the other trainer tests.
  }, 60_000);

  it('does not count an ineligible sample', () => {
    const old = sample(900, 1, { ageDays: 400 });
    const rows = rowsOf([...separated(3, 3), old]);
    expect(learningCounts(rows)).toEqual({ explicit: 6, likes: 3, dislikes: 3 });
    expect(eligibleRows([old], ELIG).skipped).toEqual({ too_old: 1 });
  });
});

describe('sampleFeedIds', () => {
  it('prefers the manifest feed ids', () => {
    const s = withManifest(sample(1, 1), ['3', '4']);
    expect(sampleFeedIds(s.features)).toEqual(['3', '4']);
  });

  it('falls back to the source feed', () => {
    expect(sampleFeedIds(sample(1, 1).features)).toEqual(['7']);
    expect(sampleFeedIds(withSourceFeed(sample(1, 1), null).features)).toEqual([]);
    expect(sampleFeedIds(null)).toEqual([]);
  });

  it('ignores a malformed manifest', () => {
    expect(sampleFeedIds(withManifest(sample(1, 1), [1, 2]).features)).toEqual(['7']);
    expect(sampleFeedIds(withManifest(sample(1, 1), 'x').features)).toEqual(['7']);
  });
});

describe('feedAgreement', () => {
  it('filters by manifest, by source feed fallback, and counts a multi-feed sample for both', () => {
    const samples = [
      withManifest(sample(1, 1), ['3']),
      withManifest(sample(2, 0), ['3', '4']),
      sample(3, 1),
      withSourceFeed(sample(4, 0), '4'),
    ];
    const rows = rowsOf(samples);
    const at = (id: string) => feedAgreement(rows, id, CFG, 'seed');
    expect([at('3').likes, at('3').dislikes]).toEqual([1, 1]);
    expect([at('4').likes, at('4').dislikes]).toEqual([0, 2]);
    expect([at('7').likes, at('7').dislikes]).toEqual([1, 0]);
    expect([at('9').likes, at('9').dislikes]).toEqual([0, 0]);
  });

  it('is collecting with two likes', () => {
    const r = feedAgreement(rowsOf(separated(2, 6)), '7', CFG, 'seed');
    expect(r.status).toBe('collecting');
  });

  it('is one_sided with ten likes and one dislike', () => {
    const r = feedAgreement(rowsOf(separated(10, 1)), '7', CFG, 'seed');
    expect(r.status).toBe('one_sided');
    expect(FEED_AGREEMENT.oneSidedMinTotal).toBe(10);
  });

  it('is ready, not one_sided, when the cards separate a small minority of likes', () => {
    const r = feedAgreement(rowsOf(separated(12, 100)), '7', CFG, 'seed');
    expect(r.status).toBe('ready');
  });

  it('is ready when the cards separate the ratings', () => {
    const r = feedAgreement(rowsOf(separated(6, 6)), '7', CFG, 'seed');
    expect(r.status).toBe('ready');
    expect(r.auc).toBe(1);
    expect(r.aucLow).not.toBeNull();
    expect(r.aucLow ?? 0).toBeGreaterThanOrEqual(CFG.model.minCvAuc);
    expect(r.ratedHigh).toEqual({ total: 6, liked: 6 });
    expect(r.ratedLow).toEqual({ total: 6, disliked: 6 });
  });

  it('is not_yet when the cards do not track the ratings', () => {
    const samples = Array.from({ length: 12 }, (_, i) =>
      sample(i, i % 2 === 0 ? 1 : 0, { pA: 0.1 + (((i * 5) % 12) / 12) * 0.8 }),
    );
    const r = feedAgreement(rowsOf(samples), '7', CFG, 'seed');
    expect(r.likes).toBe(6);
    expect(r.dislikes).toBe(6);
    expect(r.status).toBe('not_yet');
  });

  it('splits rated articles at the For-you threshold', () => {
    const samples = [
      sample(1, 1, { pA: 0.9 }),
      sample(2, 0, { pA: 0.9 }),
      sample(3, 0, { pA: 0.2 }),
      sample(4, 1, { pA: 0.2 }),
      sample(5, 0, { pA: 0.2 }),
    ];
    const r = feedAgreement(rowsOf(samples), '7', CFG, 'seed');
    expect(r.ratedHigh).toEqual({ total: 2, liked: 1 });
    expect(r.ratedLow).toEqual({ total: 3, disliked: 2 });
  });

  it('lists the likes every card scored below Maybe, newest first, and suggests a card at enough of them (D-241)', () => {
    const samples = [
      sample(1, 1, { pA: 0.05, ageDays: 3 }),
      sample(2, 1, { pA: 0.05, ageDays: 1 }),
      sample(3, 1, { pA: 0.05, ageDays: 2 }),
      sample(4, 1, { pA: 0.9 }),
      sample(5, 0, { pA: 0.05 }),
    ];
    const r = feedAgreement(rowsOf(samples), '7', CFG, 'seed');
    expect(r.uncovered).toEqual({
      count: 3,
      articleIds: ['art-2', 'art-3', 'art-1'],
      suggest: true,
      items: [
        { articleId: 'art-2', at: expect.any(Date) },
        { articleId: 'art-3', at: expect.any(Date) },
        { articleId: 'art-1', at: expect.any(Date) },
      ],
    });
    const times = r.uncovered.items.map((item) => item.at.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('lists every uncovered like as an item, beyond the drafted articles', () => {
    const likes = Array.from({ length: 8 }, (_, i) => sample(i, 1, { pA: 0.05 }));
    const r = feedAgreement(rowsOf(likes), '7', CFG, 'seed');
    expect(r.uncovered.items).toHaveLength(8);
    expect(r.uncovered.articleIds).toEqual(
      r.uncovered.items.slice(0, FEED_AGREEMENT.uncoveredArticles).map((item) => item.articleId),
    );
  });

  it('lists topical dislikes that no Never card caught, newest first, and suggests a card at enough of them', () => {
    const samples = [
      sample(1, 0, { ageDays: 3, reason: 'off_topic', pN: 0.1 }),
      sample(2, 0, { ageDays: 1, reason: null, pN: null }),
      sample(3, 0, { ageDays: 2, reason: 'off_topic', pN: 0.1 }),
      sample(4, 0, { reason: 'clickbait' }),
      sample(5, 0, { reason: 'seen' }),
      sample(6, 0, { reason: 'off_topic', pN: 0.9 }),
      sample(7, 1, { reason: 'off_topic', pN: 0.1 }),
    ];
    const r = feedAgreement(rowsOf(samples), '7', CFG, 'seed');
    expect(r.unwanted).toEqual({
      count: 3,
      articleIds: ['art-2', 'art-3', 'art-1'],
      suggest: true,
      items: [
        { articleId: 'art-2', at: expect.any(Date) },
        { articleId: 'art-3', at: expect.any(Date) },
        { articleId: 'art-1', at: expect.any(Date) },
      ],
    });
  });

  it('counts a dislike a Never card scored below Maybe, not one it scored at Maybe or above', () => {
    const low = feedAgreement(rowsOf([sample(1, 0, { pN: 0.1 })]), '7', CFG, 'seed');
    const high = feedAgreement(rowsOf([sample(1, 0, { pN: 0.9 })]), '7', CFG, 'seed');
    expect(low.unwanted.count).toBe(1);
    expect(high.unwanted.count).toBe(0);
  });

  it('never counts likes as unwanted, whatever their reason or card scores', () => {
    const likes = Array.from({ length: 6 }, (_, i) => sample(i, 1, { pN: 0.05, reason: null }));
    const r = feedAgreement(rowsOf(likes), '7', CFG, 'seed');
    expect(r.unwanted).toEqual({ count: 0, articleIds: [], suggest: false, items: [] });
  });

  it('suggests no Never card below the minimum count or share of the feed dislikes', () => {
    const few = Array.from({ length: 2 }, (_, i) => sample(i, 0));
    expect(feedAgreement(rowsOf(few), '7', CFG, 'seed').unwanted.suggest).toBe(false);
    const share = [
      ...Array.from({ length: 3 }, (_, i) => sample(i, 0)),
      ...Array.from({ length: 8 }, (_, i) => sample(10 + i, 0, { reason: 'clickbait' })),
    ];
    expect(feedAgreement(rowsOf(share), '7', CFG, 'seed').unwanted.suggest).toBe(false);
    expect(feedAgreement(rowsOf(share.slice(0, 7)), '7', CFG, 'seed').unwanted.suggest).toBe(true);
  });

  it('applies the suggestion rule to a count and the likes of the feed', () => {
    expect(uncoveredSuggests(FEED_AGREEMENT.uncoveredMin - 1, 2)).toBe(false);
    expect(uncoveredSuggests(0, 0)).toBe(false);
    expect(uncoveredSuggests(3, 10)).toBe(true);
    expect(uncoveredSuggests(3, 11)).toBe(false);
    expect(uncoveredSuggests(3, 3)).toBe(true);
  });

  it('suggests no card below the minimum count or share of the likes', () => {
    const few = feedAgreement(
      rowsOf([sample(1, 1, { pA: 0.05 }), sample(2, 1, { pA: 0.05 })]),
      '7',
      CFG,
      'seed',
    );
    expect(few.uncovered).toMatchObject({ count: FEED_AGREEMENT.uncoveredMin - 1, suggest: false });
    const covered = Array.from({ length: 10 }, (_, i) => sample(10 + i, 1, { pA: 0.9 }));
    const share = feedAgreement(
      rowsOf([...covered, ...[1, 2, 3].map((i) => sample(i, 1, { pA: 0.05 }))]),
      '7',
      CFG,
      'seed',
    );
    expect(share.uncovered).toMatchObject({ count: 3, suggest: false });
  });

  it('keeps at most the configured number of uncovered articles', () => {
    const likes = Array.from({ length: 8 }, (_, i) => sample(i, 1, { pA: 0.05 }));
    const r = feedAgreement(rowsOf(likes), '7', CFG, 'seed');
    expect(r.uncovered.count).toBe(8);
    expect(r.uncovered.articleIds).toHaveLength(FEED_AGREEMENT.uncoveredArticles);
  });

  it('is deterministic for the same seed', () => {
    const rows = rowsOf(drivenSamples(80, 'det'));
    const a = feedAgreement(rows, '7', CFG, 'seed-1');
    const b = feedAgreement(rows, '7', CFG, 'seed-1');
    expect(a).toEqual(b);
    expect(a.aucLow).not.toBeNull();
  });
});
