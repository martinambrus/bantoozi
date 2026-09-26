import {
  buildL2Question,
  cardQuestion,
  labelQuestion,
  type CardBody,
  type L2Branch,
} from '../cards.js';
import { dynamicQuestionSet } from './define.js';

/**
 * Question set `match-v1` (Call B, spec 05 §2, §4, §5.2): one Noul per card or label and one
 * level-2 Choice per selected branch, built per article. The set is hashed over its template: the
 * builders applied to these fixed placeholders. The template covers the `as_written` path; every
 * optional-field, language and example path is pinned by the builder tests, and each built question
 * is hashed again as the answer's `card_input_sha256`.
 */

export const PLACEHOLDER_CARD: CardBody = {
  interest: '{{interest}}',
  not_for: '{{not_for}}',
  examples_yes: ['{{yes}}'],
  examples_no: ['{{no}}'],
};

export const PLACEHOLDER_LABEL = { title: '{{title}}', body: PLACEHOLDER_CARD } as const;

export const PLACEHOLDER_L1: L2Branch = {
  nameEn: '{{l1_name}}',
  children: [{ id: '{{l1}}.{{l2}}', nameEn: '{{l2_name}}' }],
};

export const MATCH_V1 = dynamicQuestionSet({
  kind: 'match',
  version: 'match-v1',
  card: cardQuestion(PLACEHOLDER_CARD, 'as_written'),
  label: labelQuestion(PLACEHOLDER_LABEL, 'as_written'),
  l2: buildL2Question(PLACEHOLDER_L1),
});
