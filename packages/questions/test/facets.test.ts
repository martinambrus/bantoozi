import { describe, expect, it } from 'vitest';

import {
  FEATURE_BUILDER_VERSION,
  L1_IDS,
  flattenFacets,
  type Answer,
  type ChoiceAnswer,
} from '../src/index.js';

const choiceAnswer = (probabilities: Record<string, number>): ChoiceAnswer => {
  const [choice] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]!;
  return { type: 'choice', choice, probabilities, confidence: 0.5 };
};

const ANSWERS: Record<string, Answer> = {
  content_type: choiceAnswer({
    news_report: 0.55,
    analysis: 0.2,
    opinion: 0.05,
    tutorial: 0.02,
    review: 0.03,
    listicle: 0.01,
    press_release: 0.04,
    deal_or_ad: 0.01,
    job_or_event: 0.01,
    media: 0.03,
    interview: 0.04,
    other: 0.01,
  }),
  topic_l1: choiceAnswer({ technology: 0.6, science: 0.25, business: 0.1, other: 0.05 }),
  depth: {
    type: 'score',
    score: 2.4,
    probabilities: [0.05, 0.1, 0.3, 0.45, 0.1],
    confidence: 0.62,
    levels: 5,
  },
  clickbait: { type: 'noul', p: 0.12 },
  promotional: { type: 'noul', p: 0.08 },
  time_sensitive: { type: 'noul', p: 0.7 },
  evergreen: { type: 'noul', p: 0.35 },
  local_scope: choiceAnswer({
    global: 0.8,
    national: 0.1,
    regional_or_city: 0.05,
    not_geographic: 0.05,
  }),
  tone: {
    type: 'score',
    score: 2,
    probabilities: [0, 0.1, 0.8, 0.1, 0],
    confidence: 0.7,
    levels: 5,
  },
  paywall_teaser: { type: 'noul', p: 0.02 },
};

const L2: Record<string, ChoiceAnswer> = {
  technology: choiceAnswer({ ai_ml: 0.7, software_dev: 0.2, none_of_these: 0.1 }),
  science: choiceAnswer({ research_academia: 0.5, none_of_these: 0.5 }),
};

describe('flattenFacets (spec 05 §3.4)', () => {
  it('flattens enrich and level-2 answers into the feature map', () => {
    const features = flattenFacets(ANSWERS, L2);
    expect(features).toMatchSnapshot();
    expect(Object.keys(features).filter((key) => key.startsWith('ct.'))).toHaveLength(12);
    expect(Object.keys(features).filter((key) => key.startsWith('t1.'))).toHaveLength(20);
    expect(Object.keys(features).filter((key) => key.startsWith('t2_asked.'))).toHaveLength(19);
    expect(Object.keys(features).filter((key) => key.startsWith('scope.'))).toHaveLength(4);
    expect(features['t1.other']).toBe(0.05);
    expect(features['t1.health']).toBe(0);
    expect(features['t2.technology.ai_ml']).toBeCloseTo(0.42, 12);
    expect(features['t2.technology.software_dev']).toBeCloseTo(0.12, 12);
    expect(features['t2.technology.cybersecurity']).toBe(0);
    expect(features['t2.science.research_academia']).toBeCloseTo(0.125, 12);
    expect(features['t2.science.space']).toBe(0);
    expect(features).not.toHaveProperty('t2.technology.none_of_these');
    expect(features).not.toHaveProperty('t2.business.startups');
    expect(features['t2_asked.technology']).toBe(1);
    expect(features['t2_asked.science']).toBe(1);
    expect(features['t2_asked.business']).toBe(0);
    expect(features).not.toHaveProperty('t2_asked.other');
    expect(features['depth']).toBeCloseTo(0.6, 12);
    expect(features['depth_conf']).toBe(0.62);
    expect(features['tone']).toBe(0.5);
    expect(features['clickbait']).toBe(0.12);
    expect(features['scope.global']).toBe(0.8);
  });

  it('marks unasked branches as unasked, not as negative evidence', () => {
    const features = flattenFacets(ANSWERS, {});
    for (const l1 of L1_IDS.filter((id) => id !== 'other')) {
      expect(features[`t2_asked.${l1}`]).toBe(0);
    }
    expect(Object.keys(features).some((key) => key.startsWith('t2.'))).toBe(false);
  });

  it('rejects missing or mistyped answers and branches without a level-2 question', () => {
    const { tone: _tone, ...withoutTone } = ANSWERS;
    expect(() => flattenFacets(withoutTone, {})).toThrow(/tone/);
    expect(() => flattenFacets({ ...ANSWERS, depth: { type: 'noul', p: 1 } }, {})).toThrow(/depth/);
    expect(() => flattenFacets(ANSWERS, { other: choiceAnswer({ none_of_these: 1 }) })).toThrow(
      /branch other/,
    );
    expect(() => flattenFacets(ANSWERS, { nope: choiceAnswer({ x: 1 }) })).toThrow(/branch nope/);
  });

  it('versions the feature builder', () => {
    expect(FEATURE_BUILDER_VERSION).toBe('facets-v1');
  });
});
