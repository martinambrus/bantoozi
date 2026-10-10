import { type Answer, type ChoiceAnswer, ENRICH_V1, flattenFacets } from '@bantoozi/questions';
import { FEATURE_SPEC_V1_NAMES } from '@bantoozi/ranker';
import { describe, expect, it } from 'vitest';

const uniformChoice = (options: readonly string[]): ChoiceAnswer => ({
  type: 'choice',
  choice: options[0] ?? '',
  probabilities: Object.fromEntries(options.map((option) => [option, 1 / options.length])),
  confidence: 0.5,
});

const questions = ENRICH_V1.questions;

const ANSWERS: Record<string, Answer> = {
  content_type: uniformChoice(Object.keys(questions.content_type.criteria)),
  topic_l1: uniformChoice(['technology', 'science', 'other']),
  depth: {
    type: 'score',
    score: 2,
    probabilities: [0, 0.1, 0.8, 0.1, 0],
    confidence: 0.7,
    levels: 5,
  },
  clickbait: { type: 'noul', p: 0.1 },
  promotional: { type: 'noul', p: 0.1 },
  time_sensitive: { type: 'noul', p: 0.1 },
  evergreen: { type: 'noul', p: 0.1 },
  paywall_teaser: { type: 'noul', p: 0.1 },
  local_scope: uniformChoice(Object.keys(questions.local_scope.criteria)),
  tone: {
    type: 'score',
    score: 2,
    probabilities: [0, 0.1, 0.8, 0.1, 0],
    confidence: 0.7,
    levels: 5,
  },
};

const facetNames = (): readonly string[] => FEATURE_SPEC_V1_NAMES.slice(10, 54);

describe('FEATURE_SPEC_V1 facet names against the facet flattening (spec 05 §3.4, spec 06 §8.1)', () => {
  it('lists exactly the keys flattenFacets produces for a complete enrich-v1 answer set', () => {
    const flattened = Object.keys(flattenFacets(ANSWERS, {})).filter(
      (key) => !key.startsWith('t2_asked.') && !key.startsWith('t2.'),
    );
    expect(flattened).toHaveLength(44);
    expect([...facetNames()].sort()).toEqual([...flattened].sort());
  });

  it('takes no level-2 feature, with or without current level-2 answers', () => {
    const withBranch = flattenFacets(ANSWERS, {
      technology: uniformChoice(['ai_ml', 'software_dev', 'none_of_these']),
    });
    expect(Object.keys(withBranch).some((key) => key.startsWith('t2.'))).toBe(true);
    expect(FEATURE_SPEC_V1_NAMES.some((name) => name.startsWith('t2'))).toBe(false);
    for (const name of facetNames()) expect(withBranch).toHaveProperty(name);
  });
});
