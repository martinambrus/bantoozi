import type { Explain, Lane, ScoreSource } from '@bantoozi/shared';

import { RULE_CODES } from './rule-codes.js';
import type { Tier } from './types.js';

/** The ranking columns of a stored `user_article` row: the user's one global result (§7 step 5). */
export interface StoredRank {
  lane: Lane;
  tier: Tier | null;
  pLike: number | null;
  scoreSource: ScoreSource;
  rulesFired: readonly string[];
  explain: Explain | null;
  labelSuggestions: readonly string[];
}

/** The column defaults of a `user_article` row that was never ranked (spec 02). */
export const UNRANKED: StoredRank = Object.freeze({
  lane: 'new',
  tier: null,
  pLike: null,
  scoreSource: 'none',
  rulesFired: Object.freeze([]),
  explain: null,
  labelSuggestions: Object.freeze([]),
});

/**
 * The first explicit hide or mute rule that matches the item (spec 06 §3.1), as the rules engine
 * reports it: `mute_keyword:<value>`, `mute_story`, `block_feed`, `block_domain` or `block_author`.
 */
export interface HideRuleMatch {
  code: string;
  ruleId?: string | undefined;
  detail?: string | undefined;
}

export interface ViewProjectionInput {
  /** The row's authorized carriers: the user's carriers of this article admitted for inference. */
  inferenceFeedIds: readonly string[];
  /**
   * The feeds the view permits: a feed view's feed or a folder's feeds. `null` is the global view,
   * where every authorized carrier counts.
   */
  viewFeedIds: ReadonlySet<string> | readonly string[] | null;
  /** The stored global result; `null` when the row was never ranked. */
  cached: StoredRank | null;
  /** The explicit local hide/mute rule result; read only for the neutral projection. */
  hideRule: HideRuleMatch | null;
}

export interface ViewProjection {
  /** `shown`: the cached global score; `not_requested`: the neutral projection. */
  inference: 'shown' | 'not_requested';
  rank: StoredRank;
}

/**
 * Whether a view may show inference for a row (spec 06 §6.4): at least one of its authorized
 * carriers is in the view's permitted feed set. A bookmark-only row without an authorized
 * subscription has none, so it stays neutral too.
 */
export function isInferenceVisibleInView(
  inferenceFeedIds: readonly string[],
  viewFeedIds: ReadonlySet<string> | readonly string[] | null,
): boolean {
  if (viewFeedIds === null) return inferenceFeedIds.length > 0;
  const permitted = viewFeedIds instanceof Set ? viewFeedIds : new Set(viewFeedIds);
  return inferenceFeedIds.some((feedId) => permitted.has(feedId));
}

/**
 * The view-scoped inference projection (spec 06 §6.4; spec 08 §5.1 "Demand projection"). A view
 * with at least one authorized carrier shows the cached global score unchanged: the view decides
 * only whether inference may be shown, not which evidence counts (card scope and the model's
 * source feature cover all authorized carriers). Otherwise the row is neutral: lane `new`, no P or
 * tier, source `none`, no never/must/model result, no label suggestions, and `inference_not_requested`
 * explains it. Only the explicit hide/mute rule still applies there (lane `hidden` with its code,
 * checked first as in §2 step 1). So an off feed A stays neutral while active feed B, which carries
 * the same article, supplied the stored score.
 *
 * The neutral explanation keeps the cached `explain.inputs` (the same input snapshot) and drops
 * every inferred part; a row without a stored explanation gets none. Callers also skip semantic
 * story folding for neutral rows and keep the reader state (read, rating, bookmark, manual labels).
 * The projection needs no provider work and never changes the stored global result.
 */
export function projectRankForView(input: ViewProjectionInput): ViewProjection {
  if (isInferenceVisibleInView(input.inferenceFeedIds, input.viewFeedIds)) {
    return { inference: 'shown', rank: input.cached ?? UNRANKED };
  }
  const { hideRule } = input;
  const lane: Lane = hideRule === null ? 'new' : 'hidden';
  const rules: Explain['rules'] =
    hideRule === null ? [{ code: RULE_CODES.inferenceNotRequested }] : [explainRule(hideRule)];
  const cachedExplain = input.cached?.explain ?? null;
  return {
    inference: 'not_requested',
    rank: {
      lane,
      tier: null,
      pLike: null,
      scoreSource: 'none',
      rulesFired: rules.map((rule) => rule.code),
      explain:
        cachedExplain === null
          ? null
          : {
              v: 1,
              inputs: { ...cachedExplain.inputs },
              source: 'none',
              p: null,
              lane,
              tier: null,
              cards: [],
              rules,
            },
      labelSuggestions: [],
    },
  };
}

function explainRule(rule: HideRuleMatch): Explain['rules'][number] {
  return {
    code: rule.code,
    ...(rule.ruleId === undefined ? {} : { ruleId: rule.ruleId }),
    ...(rule.detail === undefined ? {} : { detail: rule.detail }),
  };
}
