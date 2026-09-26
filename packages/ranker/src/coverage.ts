import { compareBigIntStrings } from '@bantoozi/shared';

import {
  type CardEvidenceItem,
  isCardApplicable,
  isPositiveStrength,
  usableAnswer,
} from './cards.js';
import type { MatchCoverage, RankCard } from './types.js';

/**
 * What the rank handler knows about the work behind an applicable card that has no usable answer
 * (spec 05 §5.5), read from its `match_queue` row, or for a pair without a row from the article's
 * prerequisite work:
 * - `scheduled`: queued, leased or retrying normally (also the enrichment still ahead of matching)
 * - `no_key`, `budget`, `circuit_open`: deferred because no credential is active, the daily budget is
 *   spent or the breaker is open (the router's deferred outcomes, spec 04 §5)
 * - `exhausted`: `attempts = 5`, or a permanent invalid request
 */
export type CardWorkState = 'scheduled' | 'no_key' | 'budget' | 'circuit_open' | 'exhausted';

export type CardWorkStates = Readonly<Record<string, CardWorkState>>;

/** The applicable positive cards by status, each list in numeric id order. */
export interface CoverageReport {
  coverage: MatchCoverage;
  answered: string[];
  pending: string[];
  unavailable: string[];
}

/**
 * Reader-specific match coverage (spec 05 §5.5, "Reader-specific coverage contract"; spec 06 §2).
 * Only the user's positive cards that apply to the item's authorized carriers count; never-cards and
 * labels have independent coverage. Per card:
 * - a usable answer (validated, not `prefilter`) → answered
 * - otherwise its work state: `scheduled` → pending; `no_key`, `budget`, `circuit_open`,
 *   `exhausted` → unavailable
 * - no work state: a `prefilter` marker → unavailable; nothing at all → pending (missing work
 *   scheduled normally)
 *
 * The item is `complete` when every applicable positive card is answered (vacuously so with none;
 * the ranker then leaves the item in New), `pending` while any is pending, and `unavailable` when
 * the rest can make no progress. A pending card will answer through normal processing, so an item
 * without usable answers waits in New; only when nothing can progress does the BM25 fallback
 * apply (spec 06 §2 step 4c). Callers check inference eligibility first (spec 06 §2 step 1b):
 * items without authorized carriers are unclassified, never degraded.
 */
export function matchCoverage(
  cards: readonly RankCard[],
  item: CardEvidenceItem,
  work: CardWorkStates = {},
): CoverageReport {
  const report: CoverageReport = {
    coverage: 'complete',
    answered: [],
    pending: [],
    unavailable: [],
  };
  const applicable = cards
    .filter((card) => isPositiveStrength(card.strength))
    .filter((card) => isCardApplicable(card, item.inferenceFeedIds))
    .map((card) => card.cardId)
    .sort(compareBigIntStrings);
  for (const cardId of new Set(applicable)) {
    report[cardStatus(cardId, item, work)].push(cardId);
  }
  if (report.pending.length > 0) report.coverage = 'pending';
  else if (report.unavailable.length > 0) report.coverage = 'unavailable';
  return report;
}

function cardStatus(
  cardId: string,
  item: CardEvidenceItem,
  work: CardWorkStates,
): 'answered' | 'pending' | 'unavailable' {
  if (usableAnswer(item.cardAnswers, cardId) !== undefined) return 'answered';
  const state = Object.hasOwn(work, cardId) ? work[cardId] : undefined;
  if (state !== undefined) return state === 'scheduled' ? 'pending' : 'unavailable';
  const marker = Object.hasOwn(item.cardAnswers, cardId) ? item.cardAnswers[cardId] : undefined;
  return marker?.engine === 'prefilter' ? 'unavailable' : 'pending';
}
