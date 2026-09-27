import { CLUSTER_MAX_CANDIDATES, clusterQuestions } from '../cluster.js';
import { dynamicQuestionSet } from './define.js';

/**
 * Question set `cluster-v1` (spec 05 §6): `same_story` over `c1…cN` plus `none` (N = 1–5
 * candidates) and `is_followup`. Hashed over the template with N = 5; calls use
 * `clusterQuestions(n)` for their actual candidate count.
 */
export const CLUSTER_V1 = dynamicQuestionSet({
  kind: 'cluster',
  version: 'cluster-v1',
  questions: clusterQuestions(CLUSTER_MAX_CANDIDATES),
});
