import { canonicalJson } from '@bantoozi/shared';
import { canonicalSha256, sha256Hex } from '@bantoozi/shared/server';
import { describe, expect, it } from 'vitest';

import {
  ALL_QUESTION_SETS,
  CLUSTER_V1,
  ENRICH_V1,
  L1_IDS,
  LATEST_QUESTION_SETS,
  MATCH_V1,
  PLACEHOLDER_CARD,
  PLACEHOLDER_L1,
  PLACEHOLDER_LABEL,
  PLACEHOLDER_SUGGEST_OPTION,
  QUESTION_SET_KINDS,
  SUGGEST_QUESTION_KEY,
  SUGGEST_V1,
  buildL2Question,
  buildSuggestQuestion,
  cardQuestion,
  clusterQuestions,
  labelQuestion,
  questionLimitProblems,
  questionSetBySha,
  questionSetByVersion,
  type Question,
} from '../src/index.js';

/** Reverses the key order of every object, recursively (arrays keep their order). */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, item]) => [key, reverseKeys(item)]),
  );
}

describe('canonical JSON hashing', () => {
  it('is stable across key order', () => {
    expect(canonicalSha256({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: 3 } })).toBe(
      canonicalSha256({ a: { c: 3, d: [2, { x: 2, y: 1 }] }, b: 1 }),
    );
    expect(canonicalSha256(reverseKeys(ENRICH_V1.definition))).toBe(ENRICH_V1.sha256);
    expect(canonicalSha256(reverseKeys(MATCH_V1.definition))).toBe(MATCH_V1.sha256);
  });

  it('changes with any wording, order of levels or value', () => {
    const levels = ['a', 'b'];
    expect(canonicalSha256({ levels })).not.toBe(
      canonicalSha256({ levels: [...levels].reverse() }),
    );
    const changed = structuredClone(ENRICH_V1.definition) as unknown as {
      questions: { tone: Question };
    };
    changed.questions.tone.instructions = 'What is the tone of `article`?';
    expect(canonicalSha256(changed)).not.toBe(ENRICH_V1.sha256);
  });
});

describe('question sets', () => {
  it('hash a static set over {kind, version, questions}', () => {
    expect(ENRICH_V1.definition).toEqual({
      kind: 'enrich',
      version: 'enrich-v1',
      questions: ENRICH_V1.questions,
    });
    expect(ENRICH_V1.sha256).toBe(
      sha256Hex(
        canonicalJson({ kind: 'enrich', version: 'enrich-v1', questions: ENRICH_V1.questions }),
      ),
    );
  });

  it('hash each dynamic set over its template: the template sha equals the stored definition sha', () => {
    const templates = {
      'match-v1': {
        kind: 'match',
        version: 'match-v1',
        card: cardQuestion(PLACEHOLDER_CARD, 'as_written'),
        label: labelQuestion(PLACEHOLDER_LABEL, 'as_written'),
        l2: buildL2Question(PLACEHOLDER_L1),
      },
      'cluster-v1': { kind: 'cluster', version: 'cluster-v1', questions: clusterQuestions(5) },
      'suggest-v1': {
        kind: 'suggest',
        version: 'suggest-v1',
        questions: { [SUGGEST_QUESTION_KEY]: buildSuggestQuestion([PLACEHOLDER_SUGGEST_OPTION]) },
      },
    };
    for (const set of [MATCH_V1, CLUSTER_V1, SUGGEST_V1]) {
      const template = templates[set.version as keyof typeof templates];
      expect(canonicalSha256(template), set.version).toBe(set.sha256);
      // What `question_sets.definition` stores (a JSON round trip, keys reordered by jsonb).
      const stored: unknown = JSON.parse(JSON.stringify(reverseKeys(set.definition)));
      expect(canonicalSha256(stored), set.version).toBe(set.sha256);
      expect(stored).toEqual(template);
    }
  });

  it('pins every set hash: a changed builder or wording needs a new version', () => {
    expect(Object.fromEntries(ALL_QUESTION_SETS.map((set) => [set.version, set.sha256]))).toEqual({
      'enrich-v1': '13db2ad6512e5772cb1ec1a6e3f0ba5e406ae1fac085142ecf026dc0f31a5c32',
      'match-v1': 'b01967a1b32ddab408e1a6afdc3ccebcde46e493d56cb8522a37aa6d431a918a',
      'cluster-v1': 'eb72961ed82f2e2ab31b8b081dd011693091050fba0e83aa9d6d690c5d7b616f',
      'suggest-v1': 'adf98e00e205dbe9a64f22f7abad2a211795ff7aaa0a5cbeb7a7de0ee1dbfa80',
    });
  });

  it('ENRICH_V1 passes the TypeSafe limits', () => {
    expect(questionLimitProblems(ENRICH_V1.questions)).toEqual([]);
    const q = ENRICH_V1.questions;
    expect(Object.keys(q)).toEqual([
      'content_type',
      'topic_l1',
      'depth',
      'clickbait',
      'promotional',
      'time_sensitive',
      'evergreen',
      'local_scope',
      'tone',
      'paywall_teaser',
    ]);
    expect(Object.keys(q.content_type.criteria)).toHaveLength(12);
    expect(Object.keys(q.topic_l1.criteria)).toEqual([...L1_IDS]);
    expect(q.topic_l1.criteria['other']).toBeNull();
    expect(q.topic_l1.criteria['transport']).toEqual({
      what: 'Vehicles, mobility and travel infrastructure',
      includes: [
        'Cars',
        'Electric vehicles',
        'Public transport and rail',
        'Aviation',
        'Cycling and micromobility',
      ],
    });
    expect(q.depth.criteria).toHaveLength(5);
    expect(q.tone.criteria).toHaveLength(5);
    expect(Object.keys(q.local_scope.criteria)).toEqual([
      'global',
      'national',
      'regional_or_city',
      'not_geographic',
    ]);
  });

  it('keeps the enrich-v1 wording of spec 05 §3.3', () => {
    const q = ENRICH_V1.questions;
    expect(q.content_type.instructions).toEqual({
      question: 'What kind of piece is `article`?',
      focus: 'Judge the form of the piece, not its topic.',
    });
    expect(q.content_type.criteria['news_report']).toEqual({
      what: 'Reports a specific recent event, announcement, release, ruling or result',
      examples: ['Company X recalls 40,000 cars over brake fault'],
    });
    expect(q.content_type.criteria['other']).toBeNull();
    expect(q.clickbait).toEqual({
      type: 'noul',
      instructions:
        'Does the title of `article` withhold or exaggerate what the article actually delivers?',
      criteria: {
        true: {
          what: 'Curiosity gap, sensational framing, or a promise that the excerpt does not meet',
          examples: ["You won't believe what this app does", 'This one trick …'],
        },
        false: { what: 'The title plainly states what the article is about' },
      },
    });
    expect(q.paywall_teaser).toEqual({
      type: 'noul',
      instructions:
        "Does `article`'s text read like a teaser for content behind a paywall or login?",
    });
    expect(q.tone.criteria).toEqual([
      'Alarming or distressing',
      'Negative',
      'Neutral',
      'Positive',
      'Upbeat or celebratory',
    ]);
  });

  it('templates pass the TypeSafe limits too', () => {
    const match = MATCH_V1.definition as unknown as Record<'card' | 'label' | 'l2', Question>;
    expect(questionLimitProblems({ card: match.card, label: match.label, l2: match.l2 })).toEqual(
      [],
    );
    for (const set of [CLUSTER_V1, SUGGEST_V1]) {
      const questions = set.definition['questions'] as Record<string, Question>;
      expect(questionLimitProblems(questions), set.version).toEqual([]);
    }
  });

  it('are deeply frozen, so a handler cannot change what is sent', () => {
    expect(Object.isFrozen(ENRICH_V1)).toBe(true);
    expect(Object.isFrozen(ENRICH_V1.questions.content_type.criteria)).toBe(true);
    expect(Object.isFrozen(MATCH_V1.definition['card'])).toBe(true);
    expect(() => {
      (ENRICH_V1.questions.content_type.criteria as Record<string, unknown>)['extra'] = null;
    }).toThrow(TypeError);
  });

  it('lists every set once and finds sets by version and hash', () => {
    expect(ALL_QUESTION_SETS.map((set) => set.version)).toEqual([
      'enrich-v1',
      'match-v1',
      'cluster-v1',
      'suggest-v1',
    ]);
    expect(new Set(ALL_QUESTION_SETS.map((set) => set.sha256)).size).toBe(ALL_QUESTION_SETS.length);
    for (const set of ALL_QUESTION_SETS) {
      expect(set.definition.kind).toBe(set.kind);
      expect(set.definition.version).toBe(set.version);
      expect(questionSetByVersion(set.version)).toBe(set);
      expect(questionSetBySha(set.sha256)).toBe(set);
    }
    expect(questionSetByVersion('enrich-v0')).toBeUndefined();
    expect(questionSetBySha('0'.repeat(64))).toBeUndefined();
    expect(Object.keys(LATEST_QUESTION_SETS)).toEqual([...QUESTION_SET_KINDS]);
    for (const kind of QUESTION_SET_KINDS) expect(LATEST_QUESTION_SETS[kind].kind).toBe(kind);
  });
});
