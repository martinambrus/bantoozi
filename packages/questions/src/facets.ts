import { ENRICH_V1 } from './sets/enrich-v1.js';
import { OTHER_TOPIC_ID, TAXONOMY, taxonomyL1 } from './taxonomy.js';
import type { Answer, ChoiceAnswer } from './types.js';

/**
 * `article_facets.features` (spec 05 §3.4): the `enrich-v1` answers and the current level-2 branch
 * answers flattened into one numeric feature map for the ranker. Recomputed when level-2 answers
 * arrive after Call B.
 */

/**
 * Version of this feature builder, part of the personal model's feature-schema fingerprint: a
 * change to the feature semantics (level-2 included) must bump it (spec 05 §3.4, spec 06 §8.1).
 */
export const FEATURE_BUILDER_VERSION = 'facets-v1';

const questions = ENRICH_V1.questions;
const CONTENT_TYPE_OPTIONS = Object.keys(questions.content_type.criteria);
const LOCAL_SCOPE_OPTIONS = Object.keys(questions.local_scope.criteria);
const DEPTH_MAX = questions.depth.criteria.length - 1;
const TONE_MAX = questions.tone.criteria.length - 1;
const NOUL_FEATURES = [
  'clickbait',
  'promotional',
  'time_sensitive',
  'evergreen',
  'paywall_teaser',
] as const;

function answerOf<T extends Answer['type']>(
  answers: Readonly<Record<string, Answer>>,
  key: string,
  type: T,
): Extract<Answer, { type: T }> {
  const answer = answers[key];
  if (answer?.type !== type)
    throw new TypeError(`enrich answer ${key} is missing or not a ${type}`);
  return answer as Extract<Answer, { type: T }>;
}

function probability(answer: ChoiceAnswer, option: string): number {
  const p = answer.probabilities[option];
  return p !== undefined && Number.isFinite(p) ? p : 0;
}

/**
 * The feature map of one article (spec 05 §3.4):
 * - `ct.<option>`: the 12 `content_type` probabilities; `t1.<l1>`: the 20 `topic_l1` probabilities
 * - `t2.<l1>.<l2>` = `P(L1) × P(L2 | L1)` for each current asked branch (absent otherwise, read as 0)
 * - `t2_asked.<l1>`: 1 for a branch with a current answer, else 0 (unasked is not negative evidence)
 * - `depth` = score / 4 and `depth_conf`; `tone` = score / 4
 * - `clickbait`, `promotional`, `time_sensitive`, `evergreen`, `paywall_teaser`: Noul p
 * - `scope.<option>`: the 4 `local_scope` probabilities
 *
 * `l2Answers` holds only the current asked branches, keyed by plain level-1 id. A missing or
 * mistyped enrich answer, or a branch that has no level-2 question, is an error.
 */
export function flattenFacets(
  answers: Readonly<Record<string, Answer>>,
  l2Answers: Readonly<Record<string, ChoiceAnswer>>,
): Record<string, number> {
  const features: Record<string, number> = {};
  const contentType = answerOf(answers, 'content_type', 'choice');
  for (const option of CONTENT_TYPE_OPTIONS) {
    features[`ct.${option}`] = probability(contentType, option);
  }
  const topic = answerOf(answers, 'topic_l1', 'choice');
  for (const l1 of TAXONOMY) features[`t1.${l1.id}`] = probability(topic, l1.id);

  for (const [l1Id, l2] of Object.entries(l2Answers)) {
    const branch = taxonomyL1(l1Id);
    if (branch === undefined || branch.children.length === 0 || l2?.type !== 'choice') {
      throw new TypeError(`invalid level-2 answer for branch ${l1Id}`);
    }
    const pL1 = probability(topic, l1Id);
    for (const child of branch.children) {
      const short = child.id.slice(l1Id.length + 1);
      features[`t2.${child.id}`] = pL1 * probability(l2, short);
    }
  }
  for (const l1 of TAXONOMY) {
    if (l1.id === OTHER_TOPIC_ID) continue;
    features[`t2_asked.${l1.id}`] = Object.hasOwn(l2Answers, l1.id) ? 1 : 0;
  }

  const depth = answerOf(answers, 'depth', 'score');
  features['depth'] = depth.score / DEPTH_MAX;
  features['depth_conf'] = depth.confidence;
  for (const key of NOUL_FEATURES) features[key] = answerOf(answers, key, 'noul').p;
  const scope = answerOf(answers, 'local_scope', 'choice');
  for (const option of LOCAL_SCOPE_OPTIONS)
    features[`scope.${option}`] = probability(scope, option);
  features['tone'] = answerOf(answers, 'tone', 'score').score / TONE_MAX;
  return features;
}
