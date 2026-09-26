import { describe, expect, it } from 'vitest';

import {
  CLUSTER_REFERENCE_TIME,
  buildClusterState,
  clusterFoldDecision,
  clusterKeys,
  clusterQuestions,
  relativeToNew,
  selectClusterCandidates,
  type Answer,
  type ClusterItem,
} from '../src/index.js';

const HOUR = 3_600_000;
const NOW = new Date('2026-09-26T12:00:00Z');
const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR);

describe('cluster candidates (spec 05 §6 step 1)', () => {
  it('keeps at most two per feed and stops at five', () => {
    const rows = ['A', 'A', 'A', 'B', 'C', 'B', 'B', 'D', 'E'].map((feedId, i) => ({
      id: String(i + 1),
      feedId,
    }));
    expect(selectClusterCandidates(rows).map((row) => row.id)).toEqual(['1', '2', '4', '5', '6']);
    expect(selectClusterCandidates([])).toEqual([]);
  });

  it('walks at most the first 20 rows', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      feedId: i < 20 ? 'A' : `F${i}`,
    }));
    expect(selectClusterCandidates(rows).map((row) => row.id)).toEqual(['0', '1']);
  });
});

describe('cluster state (spec 05 §6 step 3)', () => {
  it('computes coarse relative times in code', () => {
    expect(relativeToNew(at(0), NOW)).toBe('within an hour of `new`');
    expect(relativeToNew(at(-0.99), NOW)).toBe('within an hour of `new`');
    expect(relativeToNew(at(0.5), NOW)).toBe('within an hour of `new`');
    expect(relativeToNew(at(-1), NOW)).toBe('1 hour before `new`');
    expect(relativeToNew(at(1.02), NOW)).toBe('1 hour after `new`');
    expect(relativeToNew(at(-2.5), NOW)).toBe('2 hours before `new`');
    expect(relativeToNew(at(-47.9), NOW)).toBe('47 hours before `new`');
    expect(relativeToNew(at(-48), NOW)).toBe('2 days before `new`');
    expect(relativeToNew(at(-72), NOW)).toBe('3 days before `new`');
    expect(() => relativeToNew(new Date(Number.NaN), NOW)).toThrow(RangeError);
  });

  it('builds {new, candidates} with c1…cN ids, bounded excerpts and no dates', () => {
    const newItem: ClusterItem = {
      title: 'Bridge closed after crack found',
      excerpt: `${'Engineers found a crack. '.repeat(20)}`,
      feed: 'City News',
      at: NOW,
    };
    const candidates: ClusterItem[] = [
      { title: 'Crack closes city bridge', excerpt: null, feed: 'Metro', at: at(-2) },
      {
        title: 'Bridge inspection planned',
        excerpt: 'Inspectors will check it.',
        feed: null,
        at: at(0.5),
      },
    ];
    const { state, keys } = buildClusterState(newItem, candidates);
    expect(keys).toEqual(['c1', 'c2']);
    expect(state.new.published).toBe(CLUSTER_REFERENCE_TIME);
    expect(Array.from(state.new.excerpt ?? '').length).toBeLessThanOrEqual(300);
    expect(state.candidates).toEqual([
      {
        id: 'c1',
        title: 'Crack closes city bridge',
        excerpt: null,
        feed: 'Metro',
        published: '2 hours before `new`',
      },
      {
        id: 'c2',
        title: 'Bridge inspection planned',
        excerpt: 'Inspectors will check it.',
        feed: null,
        published: 'within an hour of `new`',
      },
    ]);
    expect(JSON.stringify(state)).not.toMatch(/2026/);
    expect(() => buildClusterState(newItem, [])).toThrow(RangeError);
    expect(() =>
      buildClusterState(
        newItem,
        Array.from({ length: 6 }, () => newItem),
      ),
    ).toThrow(RangeError);
  });
});

describe('cluster-v1 questions (spec 05 §6 step 4)', () => {
  it('offers c1…cN plus none and asks is_followup', () => {
    expect(clusterQuestions(2)).toEqual({
      same_story: {
        type: 'choice',
        instructions: {
          question: 'Which item in `candidates` reports the same specific event as `new`?',
          focus: 'Same topic is not enough; it must be the same event.',
        },
        criteria: { c1: null, c2: null, none: 'No candidate reports the same specific event' },
      },
      is_followup: {
        type: 'noul',
        instructions:
          'Is `new` a follow-up with substantial new developments rather than a re-report of an event already covered in `candidates`?',
      },
    });
    expect(Object.keys(clusterQuestions(1).same_story.criteria)).toEqual(['c1', 'none']);
    expect(Object.keys(clusterQuestions(5).same_story.criteria)).toHaveLength(6);
    for (const bad of [0, 6, 1.5]) expect(() => clusterQuestions(bad)).toThrow(RangeError);
    expect(clusterKeys(3)).toEqual(['c1', 'c2', 'c3']);
  });
});

describe('cluster fold rule (spec 05 §6 step 5)', () => {
  const answers = (choice: string, p: number, followup: number): Record<string, Answer> => ({
    same_story: {
      type: 'choice',
      choice,
      probabilities: { c1: 0, c2: 0, c3: 0, none: 0, [choice]: p },
      confidence: 0.5,
    },
    is_followup: { type: 'noul', p: followup },
  });
  const keys = ['c1', 'c2', 'c3'];

  it.each([
    // same_story, p(chosen), is_followup → decision
    ['c2', 0.7, 0.49, { fold: true, key: 'c2' }],
    ['c1', 0.95, 0.0, { fold: true, key: 'c1' }],
    ['c3', 1.0, 0.2, { fold: true, key: 'c3' }],
    ['c2', 0.69, 0.1, { fold: false }],
    ['c2', 0.9, 0.5, { fold: false }],
    ['c2', 0.9, 0.8, { fold: false }],
    ['c2', 0.5, 0.9, { fold: false }],
    ['none', 0.9, 0.1, { fold: false }],
    ['none', 0.5, 0.9, { fold: false }],
    ['c4', 0.9, 0.1, { fold: false }],
  ] as const)('same_story=%s p=%s is_followup=%s', (choice, p, followup, expected) => {
    expect(clusterFoldDecision(answers(choice, p, followup), keys)).toEqual(expected);
  });

  it('never folds on missing or mistyped answers', () => {
    expect(clusterFoldDecision({}, keys)).toEqual({ fold: false });
    const valid = answers('c1', 0.9, 0.1);
    expect(clusterFoldDecision({ same_story: valid['same_story']! }, keys)).toEqual({
      fold: false,
    });
    expect(
      clusterFoldDecision(
        {
          ...valid,
          is_followup: { type: 'score', score: 0, probabilities: [], confidence: 0, levels: 2 },
        },
        keys,
      ),
    ).toEqual({ fold: false });
    expect(
      clusterFoldDecision(
        {
          ...valid,
          same_story: { type: 'choice', choice: 'c1', probabilities: {}, confidence: 1 },
        },
        keys,
      ),
    ).toEqual({ fold: false });
  });
});
