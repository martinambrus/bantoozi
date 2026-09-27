import { buildSuggestQuestion, SUGGEST_QUESTION_KEY } from '../suggest.js';
import { dynamicQuestionSet } from './define.js';

/**
 * Question set `suggest-v1` (spec 05 §7): one Choice over up to 60 library cards (`c<cardId>`, each
 * `{what: interest, not_for?}`) plus `none`. Hashed over the template with one placeholder card.
 */
export const PLACEHOLDER_SUGGEST_OPTION = {
  key: 'c{{card_id}}',
  interest: '{{interest}}',
  notFor: '{{not_for}}',
} as const;

export const SUGGEST_V1 = dynamicQuestionSet({
  kind: 'suggest',
  version: 'suggest-v1',
  questions: { [SUGGEST_QUESTION_KEY]: buildSuggestQuestion([PLACEHOLDER_SUGGEST_OPTION]) },
});
