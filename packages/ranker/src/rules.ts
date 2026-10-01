import { compareBigIntStrings, normalizeText } from '@bantoozi/shared';

import type { FloorTrigger } from './policy.js';
import type { HideRuleMatch } from './projection.js';
import { muteKeywordCode, RULE_CODES } from './rule-codes.js';
import type { RankItem } from './types.js';

/** `user_rules.kind` (spec 06 §3.1). */
export type RuleKind =
  | 'mute_keyword'
  | 'mute_story'
  | 'block_feed'
  | 'block_domain'
  | 'block_author'
  | 'boost_feed'
  | 'boost_domain';

/** One of the user's manual rules; the handler loads only rules that have not expired (§3.1). */
export interface RankRule {
  /** Bigint rule id as a decimal string. */
  id: string;
  kind: RuleKind;
  value: string;
  /** Set for a timed mute; the result may change when it passes (`next_rank_at`, §7). */
  expiresAt?: Date | undefined;
}

/** What the rules read from an item. */
export type RuleItem = Pick<
  RankItem,
  | 'feedIds'
  | 'domain'
  | 'author'
  | 'clusterId'
  | 'titleNorm'
  | 'excerptNorm'
  | 'translatedTitleNorm'
  | 'translatedExcerptNorm'
>;

/** Hide kinds in the order their match is reported: one hide rule decides the item (§2 step 1). */
const HIDE_KINDS = [
  'mute_keyword',
  'mute_story',
  'block_feed',
  'block_domain',
  'block_author',
] as const satisfies readonly RuleKind[];

/** A rule that matched, with the rule behind it (its expiry can change the result). */
export interface RuleMatch extends HideRuleMatch {
  /** Every rule whose match the result depends on (for `block_feed`, all the blocking rules). */
  rules: RankRule[];
}

/**
 * The explicit hide or mute rule that hides the item (spec 06 §3.1, §2 step 1), or `null`. The
 * kinds are checked in the table's order and rules of one kind by numeric id, so the reported rule
 * is deterministic:
 * - `mute_keyword`: `normalizeText(value)` occurs as a whole-word sequence in the normalized title or
 *   excerpt, original or translated (an empty normalized keyword matches nothing);
 * - `mute_story`: the item's cluster is the value;
 * - `block_feed`: every one of the item's subscribed carriers (a non-empty set) is blocked by some
 *   rule; one blocked carrier among unblocked ones does not hide it;
 * - `block_domain`: the registrable domain equals the value (case-insensitive);
 * - `block_author`: case- and diacritic-insensitive equality with the author.
 */
export function matchHideRule(rules: readonly RankRule[], item: RuleItem): RuleMatch | null {
  const sorted = sortRules(rules);
  for (const kind of HIDE_KINDS) {
    const ofKind = sorted.filter((rule) => rule.kind === kind);
    if (ofKind.length === 0) continue;
    if (kind === 'block_feed') {
      const match = blockFeedMatch(ofKind, item.feedIds);
      if (match !== null) return match;
      continue;
    }
    const rule = ofKind.find((candidate) => hideRuleMatches(candidate, item));
    if (rule !== undefined) return ruleMatch(rule, [rule]);
  }
  return null;
}

function hideRuleMatches(rule: RankRule, item: RuleItem): boolean {
  switch (rule.kind) {
    case 'mute_keyword':
      return keywordMatches(rule.value, item);
    case 'mute_story':
      return item.clusterId !== undefined && item.clusterId === rule.value;
    case 'block_domain':
      return domainMatches(rule.value, item.domain);
    case 'block_author':
      return (
        item.author !== null &&
        foldName(item.author) === foldName(rule.value) &&
        foldName(rule.value) !== ''
      );
    default:
      return false;
  }
}

function blockFeedMatch(rules: readonly RankRule[], feedIds: readonly string[]): RuleMatch | null {
  if (feedIds.length === 0) return null;
  const used: RankRule[] = [];
  for (const feedId of new Set(feedIds)) {
    const rule = rules.find((candidate) => candidate.value === feedId);
    if (rule === undefined) return null;
    if (!used.includes(rule)) used.push(rule);
  }
  const first = sortRules(used)[0];
  return first === undefined ? null : ruleMatch(first, sortRules(used));
}

function ruleMatch(rule: RankRule, rules: RankRule[]): RuleMatch {
  const code =
    rule.kind === 'mute_keyword' ? muteKeywordCode(rule.value) : RULE_CODES[codeKey(rule.kind)];
  return { code, ruleId: rule.id, rules };
}

function codeKey(kind: Exclude<RuleKind, 'mute_keyword'>): keyof typeof RULE_CODES {
  switch (kind) {
    case 'mute_story':
      return 'muteStory';
    case 'block_feed':
      return 'blockFeed';
    case 'block_domain':
      return 'blockDomain';
    case 'block_author':
      return 'blockAuthor';
    case 'boost_feed':
      return 'boostFeed';
    case 'boost_domain':
      return 'boostDomain';
  }
}

/** A boost rule that raises the item to the For you floor (§3.1, §2 step 6iii). */
export interface BoostMatch {
  floor: FloorTrigger;
  rule: RankRule;
}

/**
 * The boost rules that match (spec 06 §3.1): `boost_feed` when any of the item's subscribed
 * carriers is the value, `boost_domain` when the domain matches. At most one floor per kind, the
 * lowest rule id, `boost_feed` first.
 */
export function matchBoostRules(rules: readonly RankRule[], item: RuleItem): BoostMatch[] {
  const sorted = sortRules(rules);
  const matches: BoostMatch[] = [];
  const feed = sorted.find(
    (rule) => rule.kind === 'boost_feed' && item.feedIds.includes(rule.value),
  );
  if (feed !== undefined) {
    matches.push({ floor: { kind: 'boost_feed', ruleId: feed.id }, rule: feed });
  }
  const domain = sorted.find(
    (rule) => rule.kind === 'boost_domain' && domainMatches(rule.value, item.domain),
  );
  if (domain !== undefined) {
    matches.push({ floor: { kind: 'boost_domain', ruleId: domain.id }, rule: domain });
  }
  return matches;
}

/**
 * Whether a muted keyword occurs as a whole-word sequence: both sides are `normalizeText`-ed (one
 * space between words), so the keyword must start and end at word boundaries.
 */
export function keywordMatches(value: string, item: RuleItem): boolean {
  const needle = normalizeText(value);
  if (needle === '') return false;
  const fields = [
    item.titleNorm,
    item.excerptNorm,
    item.translatedTitleNorm,
    item.translatedExcerptNorm,
  ];
  return fields.some(
    (field) => field !== undefined && ` ${normalizeText(field)} `.includes(` ${needle} `),
  );
}

function domainMatches(value: string, domain: string): boolean {
  const wanted = value.trim().toLowerCase();
  return wanted !== '' && wanted === domain.trim().toLowerCase();
}

const COMBINING_MARKS = /\p{M}+/gu;

/** Case- and diacritic-insensitive form of a name (`block_author`), with whitespace collapsed. */
export function foldName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

function sortRules(rules: readonly RankRule[]): RankRule[] {
  return [...rules].sort((a, b) => compareBigIntStrings(a.id, b.id));
}
