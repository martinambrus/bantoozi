import type { TopReason } from '@bantoozi/shared';
import type { TFunction } from 'i18next';

import { formatProbability } from './format.js';

// The rule codes of packages/ranker/src/rule-codes.ts, which the web app cannot import: a code is
// `<name>` or `<name>:<suffix>`, with the card id, the muted keyword or the demotion as the suffix.
const PLAIN_RULES: ReadonlySet<string> = new Set([
  'must',
  'never',
  'never_soft',
  'mute_story',
  'block_feed',
  'block_domain',
  'block_author',
  'boost_feed',
  'boost_domain',
  'degraded',
  'llm_answer',
  'seen_story',
  'pending_cards',
  'inference_not_requested',
]);
const DEMOTIONS: ReadonlySet<string> = new Set(['clickbait', 'promotional', 'shallow', 'stale']);

function ruleText(t: TFunction, code: string): string {
  const colon = code.indexOf(':');
  const name = colon === -1 ? code : code.slice(0, colon);
  const suffix = colon === -1 ? '' : code.slice(colon + 1);
  if (PLAIN_RULES.has(name)) return t(`reason.rule.${name}`);
  if (name === 'demote' && DEMOTIONS.has(suffix)) return t(`reason.rule.demote_${suffix}`);
  if (name === 'mute_keyword' && suffix !== '') {
    return t('reason.rule.mute_keyword', { keyword: suffix });
  }
  return t('reason.rule.unknown');
}

/** Why an article is where it is, in words: "EV battery tech · 0.91", "Boosted source", … */
export function topReasonText(t: TFunction, language: string, reason: TopReason): string {
  switch (reason.kind) {
    case 'card':
      return t('reason.card', { title: reason.title, p: formatProbability(reason.p, language) });
    case 'model':
      return t('reason.model', { label: reason.label });
    case 'keyword':
      return t('reason.keyword');
    case 'rule':
      return ruleText(t, reason.code);
  }
}
