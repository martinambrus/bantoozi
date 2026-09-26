import { describe, expect, it } from 'vitest';

import * as questions from '../src/index.js';

describe('@bantoozi/questions public entry point', () => {
  it('names the package', () => {
    expect(questions.PACKAGE_NAME).toBe('@bantoozi/questions');
  });

  it('exports the API the worker handlers use', () => {
    const functions = [
      // sets
      'questionSetByVersion',
      'questionSetBySha',
      // state
      'buildArticleState',
      'effectiveStateVariant',
      'stateSha256',
      'buildSuggestState',
      // cards and level-2 topics
      'cardQuestion',
      'labelQuestion',
      'cardInputSha256',
      'cardKey',
      'parseCardKey',
      'l2Key',
      'parseL2Key',
      'l2Question',
      'selectL2Branches',
      'validateCardBody',
      // packing, facets, cluster, suggest
      'packRequests',
      'flattenFacets',
      'selectClusterCandidates',
      'buildClusterState',
      'clusterQuestions',
      'clusterFoldDecision',
      'planSuggestion',
      'suggestResults',
      // taxonomy and library
      'taxonomyTopicRows',
      'taxonomyL1Criteria',
      'loadLibraryCards',
      'libraryCardTextHash',
    ] as const;
    for (const name of functions) expect(typeof questions[name], name).toBe('function');
    for (const set of [
      questions.ENRICH_V1,
      questions.MATCH_V1,
      questions.CLUSTER_V1,
      questions.SUGGEST_V1,
    ]) {
      expect(Object.keys(set)).toEqual(
        expect.arrayContaining(['kind', 'version', 'definition', 'sha256']),
      );
    }
    expect(Object.keys(questions.ENRICH_V1)).toContain('questions');
    expect(questions.ALL_QUESTION_SETS).toHaveLength(4);
    expect(questions.DEFAULT_PACK_LIMITS).toEqual({
      maxRequestTokens: 48_000,
      maxStatePlusQuestionTokens: 28_000,
      maxQuestions: 200,
    });
    expect(new questions.PackOverflowError('c1', 30_000, 28_000)).toBeInstanceOf(Error);
    expect(questions.FEATURE_BUILDER_VERSION).toBe('facets-v1');
  });
});
