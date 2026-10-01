import { compareBigIntStrings, type Explain, type Lane, type ScoreSource } from '@bantoozi/shared';

import type { Bm25Corpus } from './bm25/corpus.js';
import { degradedScore } from './bm25/score.js';
import {
  cardScore,
  evaluateNeverCards,
  isCardApplicable,
  mustFloorCard,
  usableAnswer,
} from './cards.js';
import type { ReadonlyRankerConfig } from './config.js';
import {
  applyDemotions,
  articleAgeMs,
  DEMOTION_FLAGS,
  type DemotionFlag,
  type DemotionUserState,
  isDemotionActive,
  isDemotionTriggered,
  staleAgeReachedAt,
} from './demotions.js';
import { tierFromP } from './lanes.js';
import { applyLanePolicy, type FiredRule, type FloorTrigger } from './policy.js';
import { RULE_CODES } from './rule-codes.js';
import { matchBoostRules, matchHideRule, type RankRule, type RuleMatch } from './rules.js';
import type { ModelEngine, RankCard, RankItem, Tier } from './types.js';

/** One of the user's labels (`user_labels`): a label card with the holder's name (§1). */
export interface RankLabel {
  cardId: string;
  name: string;
}

/** A model contribution shown by "Why this?" (§6.2, §8.3). */
export interface ModelContribution {
  feature: string;
  label: string;
  contribution: number;
}

/**
 * The user's active personal model (§8), already checked compatible with the current model context
 * by the caller (a mismatch means no model in the context). M7 provides it; `score` is pure.
 */
export interface ActiveModel {
  version: number;
  /** P and the top contributions for an eligible item (§2 step 4a), or `null` when it cannot. */
  score(item: RankItem, now: Date): { p: number; top: ModelContribution[] } | null;
}

/** Everything `rankArticle` needs about the user (`UserRankContext`, spec 06 §1). */
export interface UserRankContext extends DemotionUserState {
  userId: string;
  /** `users.rank_revision` this run read, as a decimal string. */
  rankRevision: string;
  /**
   * `explain.inputs.contextSha` of every result except degraded ones: a hash of the ranking context
   * (score version, rank revision and the active model's context, §8.1) computed by the handler.
   */
  contextSha: string;
  /** `explain.inputs.contextSha` of degraded results: the context plus the BM25 corpus (§7, §9). */
  degradedContextSha: string;
  /** The validated config (shared defaults plus the settings override, §11). */
  config: ReadonlyRankerConfig;
  /** The user's held interest cards (positive and never). */
  cards: readonly RankCard[];
  labels: readonly RankLabel[];
  /** The user's rules that have not expired. */
  rules: readonly RankRule[];
  /**
   * When an `auto` flag's activation flips because a dislike leaves the window (§5, §7): the
   * earliest time the count drops below `autoMinDislikes`. Absent when it cannot change by time.
   */
  demotionDeadlines?: Readonly<Partial<Record<DemotionFlag, Date>>> | undefined;
  /** The compatible active model, if any (§8.1). */
  model?: ActiveModel | undefined;
  /** Clusters with a member the user read in the window (§2 step 6i). */
  readClusterIds: ReadonlySet<string>;
  /** Document frequencies over the user's whole window (§9). */
  bm25: Bm25Corpus;
}

/** The ranking columns of one `user_article` row (§1 `RankResult`, §7 step 5). */
export interface RankResult {
  lane: Lane;
  tier: Tier | null;
  pLike: number | null;
  scoreSource: ScoreSource;
  rulesFired: string[];
  explain: Explain;
  /** Label card ids, in numeric order. */
  labelSuggestions: string[];
  /**
   * The earliest future time at which the result can change with nothing else changing (rule expiry,
   * the stale age, an `auto` flag's window, a model freshness bin), or `null` (§7 step 5).
   */
  nextRankAt: Date | null;
}

const EXPLAIN_CARDS = 10;
const TITLE_MAX = 200;
/** The model's freshness bins (§8.1): [0,6h), [6h,24h), [24h,72h), [72h,∞). */
const AGE_BIN_HOURS = [6, 24, 72] as const;

/**
 * `rankArticle(ctx, item, now)` (spec 06 §2): the normative order of evaluation.
 *
 * 1. a hide/mute rule → `hidden` (its code); 1b. no authorized carrier → `new`,
 *    `inference_not_requested`; 2. a stale article without a current explicit selection → `new`;
 *    3. a never-card with `p ≥ never.hide` → `hidden` (`never:<id>`);
 * 4. the base P: a compatible model (complete coverage, facets, not degraded/failed, Jev answers
 *    only), else the card score with quality demotions, else BM25 when coverage is unavailable,
 *    else `new` with no score;
 * 5–8. the lane from P, the first applicable modifier (read story, degraded, floor, caps), the
 *    pending-cards rule and the tier (`applyLanePolicy`).
 *
 * Every exit returns a valid explanation; label suggestions are computed for every
 * inference-eligible item. P/tier are null on hidden and new exits.
 */
export function rankArticle(ctx: UserRankContext, item: RankItem, now: Date): RankResult {
  const config = ctx.config;
  const eligible = item.inferenceEligible && item.inferenceFeedIds.length > 0;
  const labelSuggestions = eligible ? suggestLabels(ctx, item) : [];
  const exit = (
    lane: 'hidden' | 'new',
    rules: FiredRule[],
    deadlines: readonly (Date | undefined)[] = [],
    explainEligible = eligible,
  ): RankResult =>
    result(ctx, item, now, {
      lane,
      p: null,
      source: 'none',
      rules,
      eligible: explainEligible,
      labelSuggestions,
      deadlines,
    });

  // 1. Explicit hide and mute rules apply whatever the inference mode.
  const hide = matchHideRule(ctx.rules, item);
  if (hide !== null) return exit('hidden', [hideRule(hide)], expiries(hide.rules));

  // 1b. No authorized carrier: plain chronological reading.
  if (!eligible) {
    return exit('new', [{ code: RULE_CODES.inferenceNotRequested }], [], false);
  }

  // 2. Stale articles are never processed automatically; a current explicit selection ranks them.
  if (item.pipelineState === 'stale' && !item.explicitSelection) return exit('new', []);

  // 3. A confident never-card hides.
  const never = evaluateNeverCards(ctx.cards, item, config);
  if (never.effect === 'hide') {
    return exit('hidden', [{ code: never.code, cardId: never.cardId }]);
  }

  // 4. The base probability.
  const base = baseProbability(ctx, item, now);
  if (base === null) return exit('new', []);

  // 5–8. Lane, modifiers, pending cards and tier.
  const boosts = matchBoostRules(ctx.rules, item);
  const must = mustFloorCard(ctx.cards, item, config);
  const floors: FloorTrigger[] = [
    ...(must === null ? [] : [{ kind: 'must' as const, cardId: must.cardId }]),
    ...boosts.map((boost) => boost.floor),
  ];
  const policy = applyLanePolicy(
    {
      p: base.p,
      source: base.source,
      coverage: item.matchCoverage,
      seenStory: item.clusterId !== undefined && ctx.readClusterIds.has(item.clusterId),
      floors,
      neverSoftCardId: never.effect === 'soft_cap' ? never.cardId : null,
      decidingEngine: base.source === 'cards' ? base.decidingEngine : null,
    },
    config,
  );
  const deadlines: (Date | undefined)[] = [];
  if (policy.rules.some((rule) => rule.code.startsWith('boost_'))) {
    deadlines.push(...expiries(boosts.map((boost) => boost.rule)));
  }
  deadlines.push(...base.deadlines);
  return result(ctx, item, now, {
    lane: policy.lane,
    p: policy.p,
    source: base.source,
    rules: [...base.rules, ...policy.rules],
    eligible: true,
    labelSuggestions,
    deadlines,
    ...(base.decidingCardId === undefined ? {} : { decidingCardId: base.decidingCardId }),
    ...(base.model === undefined ? {} : { model: base.model }),
  });
}

interface BaseProbability {
  p: number;
  source: Exclude<ScoreSource, 'none'>;
  rules: FiredRule[];
  decidingCardId?: string;
  decidingEngine?: ModelEngine;
  model?: NonNullable<Explain['model']>;
  /** Times at which this base P can change by itself. */
  deadlines: Date[];
}

/** §2 step 4: the model, else the cards (with demotions), else BM25; `null` for no score (4d). */
function baseProbability(ctx: UserRankContext, item: RankItem, now: Date): BaseProbability | null {
  const config = ctx.config;
  if (ctx.model !== undefined && isModelEligible(ctx.cards, item)) {
    const scored = ctx.model.score(item, now);
    if (scored !== null && isUnit(scored.p)) {
      return {
        p: scored.p,
        source: 'model',
        rules: [],
        model: { version: ctx.model.version, top: topContributions(scored.top) },
        deadlines: [nextAgeBin(item, now)].filter((d): d is Date => d !== undefined),
      };
    }
  }
  const cards = cardScore(ctx.cards, item, config);
  if (cards !== null) {
    const demotion = applyDemotions(cards.score, item, ctx, now, config);
    return {
      p: demotion.p,
      source: 'cards',
      rules: demotion.codes.map((code) => ({ code })),
      decidingCardId: cards.decidingCardId,
      decidingEngine: cards.decidingAnswer.engine,
      deadlines: demotionDeadlines(ctx, item, now),
    };
  }
  if (item.matchCoverage === 'unavailable') {
    const degraded = degradedScore(ctx.cards, item, ctx.bm25, config);
    if (degraded !== null) return { p: degraded.p, source: 'degraded', rules: [], deadlines: [] };
  }
  return null;
}

/**
 * §2 step 4a eligibility besides the model's compatibility: complete coverage, facets present, the
 * pipeline not degraded/failed, and Jev (`typesafe`, FEATURE_SPEC_V1's engine family) behind the
 * facets and every applicable interest answer; a `prefilter` marker is an unknown, not an engine.
 */
function isModelEligible(cards: readonly RankCard[], item: RankItem): boolean {
  if (item.matchCoverage !== 'complete' || item.facets === undefined) return false;
  if (item.pipelineState === 'degraded' || item.pipelineState === 'failed') return false;
  if (item.facetsEngine !== 'typesafe') return false;
  return cards
    .filter((card) => isCardApplicable(card, item.inferenceFeedIds))
    .every((card) => {
      const answer = usableAnswer(item.cardAnswers, card.cardId);
      return answer === undefined || answer.engine === 'typesafe';
    });
}

/** The demotion-related times at which a card score can change by itself (§5, §7). */
function demotionDeadlines(ctx: UserRankContext, item: RankItem, now: Date): Date[] {
  const config = ctx.config;
  const deadlines: Date[] = [];
  for (const flag of DEMOTION_FLAGS) {
    const active = isDemotionActive(flag, ctx, config);
    if (flag === 'stale' && !isDemotionTriggered(flag, item, now, config)) {
      // Not old enough yet: the flag triggers once the age passes `staleAgeHours`.
      const timeSensitive = item.facets?.['time_sensitive'];
      const wouldTrigger =
        typeof timeSensitive === 'number' && timeSensitive >= config.demotion.staleTimeSensitive;
      if (wouldTrigger && active) {
        deadlines.push(new Date(staleAgeReachedAt(item, now, config).getTime() + 1));
      }
    }
    const deadline = ctx.demotionDeadlines?.[flag];
    if (
      deadline !== undefined &&
      active &&
      ctx.demote[flag] === 'auto' &&
      isDemotionTriggered(flag, item, now, config)
    ) {
      deadlines.push(deadline);
    }
  }
  return deadlines;
}

/** The next model freshness-bin boundary of the item's age (§8.1), if any. */
function nextAgeBin(item: RankItem, now: Date): Date | undefined {
  const age = articleAgeMs(item, now);
  const next = AGE_BIN_HOURS.map((h) => h * 3_600_000).find((boundary) => boundary > age);
  return next === undefined ? undefined : new Date(now.getTime() + (next - age));
}

/** Label suggestions (§6.3): held labels answered with `p ≥ labelSuggest`, not yet assigned. */
function suggestLabels(ctx: UserRankContext, item: RankItem): string[] {
  const assigned = new Set(item.labelIds);
  return [...new Set(ctx.labels.map((label) => label.cardId))]
    .filter((cardId) => !assigned.has(cardId))
    .filter((cardId) => {
      const answer = usableAnswer(item.cardAnswers, cardId);
      return answer !== undefined && answer.p >= ctx.config.labelSuggest;
    })
    .sort(compareBigIntStrings);
}

interface Outcome {
  lane: Lane;
  p: number | null;
  source: ScoreSource;
  rules: FiredRule[];
  eligible: boolean;
  labelSuggestions: string[];
  deadlines: readonly (Date | undefined)[];
  decidingCardId?: string;
  model?: NonNullable<Explain['model']>;
}

function result(ctx: UserRankContext, item: RankItem, now: Date, outcome: Outcome): RankResult {
  const tier = tierFromP(outcome.p, ctx.config);
  const rules = outcome.rules.map(explainRule);
  const facets = outcome.eligible ? explainFacets(item.facets) : undefined;
  const explain: Explain = {
    v: 1,
    inputs: {
      contentRevision: item.contentRevision,
      mediaRevision: item.mediaRevision,
      rankRevision: ctx.rankRevision,
      contextSha: outcome.source === 'degraded' ? ctx.degradedContextSha : ctx.contextSha,
    },
    source: outcome.source,
    p: outcome.p,
    lane: outcome.lane,
    tier,
    ...(outcome.decidingCardId === undefined ? {} : { decidingCardId: outcome.decidingCardId }),
    cards: outcome.eligible ? explainCards(ctx.cards, item) : [],
    ...(facets === undefined ? {} : { facets }),
    rules,
    ...(outcome.model === undefined ? {} : { model: outcome.model }),
    ...(item.translation === undefined
      ? {}
      : { translation: { engine: item.translation.engine, quality: item.translation.quality } }),
    ...(item.clusterId === undefined
      ? {}
      : { cluster: { id: item.clusterId, size: Math.max(0, Math.trunc(item.clusterSize)) } }),
  };
  return {
    lane: outcome.lane,
    tier,
    pLike: outcome.p,
    scoreSource: outcome.source,
    rulesFired: rules.map((rule) => rule.code),
    explain,
    labelSuggestions: outcome.labelSuggestions,
    nextRankAt: earliestFuture(outcome.deadlines, now),
  };
}

/** The user's applicable interest cards with usable answers, p descending (ties: lowest id), ≤ 10. */
function explainCards(cards: readonly RankCard[], item: RankItem): Explain['cards'] {
  const seen = new Set<string>();
  const answered: Explain['cards'] = [];
  for (const card of cards) {
    if (seen.has(card.cardId) || !isCardApplicable(card, item.inferenceFeedIds)) continue;
    const answer = usableAnswer(item.cardAnswers, card.cardId);
    if (answer === undefined) continue;
    seen.add(card.cardId);
    answered.push({
      id: card.cardId,
      title: card.title.slice(0, TITLE_MAX),
      strength: card.strength,
      p: answer.p,
      engine: answer.engine,
    });
  }
  return answered
    .sort((a, b) => b.p - a.p || compareBigIntStrings(a.id, b.id))
    .slice(0, EXPLAIN_CARDS);
}

/**
 * The explanation's facet summary from `article_facets.features` (§6.2): the most likely content
 * type and L1 topic (with its most likely asked L2 child), and the quality facets. Omitted when any
 * of them is missing or invalid.
 */
export function explainFacets(facets: RankItem['facets']): Explain['facets'] {
  if (facets === undefined) return undefined;
  const contentType = argmax(facets, 'ct.');
  const topic = argmax(facets, 't1.');
  const values = {
    depth: facets['depth'],
    clickbait: facets['clickbait'],
    promotional: facets['promotional'],
    timeSensitive: facets['time_sensitive'],
    evergreen: facets['evergreen'],
  };
  if (contentType === null || topic === null) return undefined;
  if (!Object.values(values).every(isUnit)) return undefined;
  const l2 = argmax(facets, `t2.${topic.key}.`);
  return {
    contentType: { choice: contentType.key, p: contentType.p },
    topic: {
      l1: topic.key,
      p: topic.p,
      ...(l2 === null || l2.p <= 0 ? {} : { l2: `${topic.key}.${l2.key}` }),
    },
    depth: values.depth as number,
    clickbait: values.clickbait as number,
    promotional: values.promotional as number,
    timeSensitive: values.timeSensitive as number,
    evergreen: values.evergreen as number,
  };
}

/** The highest-probability key under a prefix (ties: the first key in code-point order). */
function argmax(
  facets: Readonly<Record<string, number>>,
  prefix: string,
): { key: string; p: number } | null {
  let best: { key: string; p: number } | null = null;
  for (const name of Object.keys(facets).sort()) {
    if (!name.startsWith(prefix)) continue;
    const key = name.slice(prefix.length);
    if (key === '' || key.includes('.') || key.length > 64) continue;
    const p = facets[name];
    if (!isUnit(p)) continue;
    if (best === null || p > best.p) best = { key, p };
  }
  return best;
}

function topContributions(top: readonly ModelContribution[]): ModelContribution[] {
  return top
    .filter((c) => Number.isFinite(c.contribution))
    .sort(
      (a, b) =>
        Math.abs(b.contribution) - Math.abs(a.contribution) ||
        (a.feature < b.feature ? -1 : a.feature > b.feature ? 1 : 0),
    )
    .slice(0, 3)
    .map((c) => ({
      feature: c.feature.slice(0, TITLE_MAX),
      label: c.label.slice(0, TITLE_MAX),
      contribution: c.contribution,
    }));
}

function hideRule(match: RuleMatch): FiredRule {
  return {
    code: match.code,
    ...(match.ruleId === undefined ? {} : { ruleId: match.ruleId }),
  };
}

function explainRule(rule: FiredRule): Explain['rules'][number] {
  return {
    code: rule.code,
    ...(rule.ruleId === undefined ? {} : { ruleId: rule.ruleId }),
    ...(rule.cardId === undefined ? {} : { cardId: rule.cardId }),
  };
}

function expiries(rules: readonly RankRule[]): Date[] {
  return rules.map((rule) => rule.expiresAt).filter((d): d is Date => d !== undefined);
}

function earliestFuture(deadlines: readonly (Date | undefined)[], now: Date): Date | null {
  let earliest: number | null = null;
  for (const deadline of deadlines) {
    const t = deadline?.getTime();
    if (t === undefined || Number.isNaN(t) || t <= now.getTime()) continue;
    if (earliest === null || t < earliest) earliest = t;
  }
  return earliest === null ? null : new Date(earliest);
}

function isUnit(p: unknown): p is number {
  return typeof p === 'number' && p >= 0 && p <= 1;
}
