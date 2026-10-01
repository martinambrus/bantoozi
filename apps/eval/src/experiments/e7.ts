import { isPositiveStrength } from '@bantoozi/ranker';
import { compareBigIntStrings } from '@bantoozi/shared';
import { sha256Hex } from '@bantoozi/shared/server';

import type { RunCard } from './run-config.js';

/**
 * E7 "steering text" (spec 10 §3, informational, development only): up to 50 development articles
 * per language that E1 answered, each with one rater chosen deterministically (seeded by the
 * article id) among the raters who rated it. The targeted variant names that rater's positive card
 * with the lowest E1 p; an article whose rater has no answered positive card is skipped. Pure: the
 * runner builds the two steered states (`states.ts`) and reruns Call B with the rater's cards.
 */

export const E7_ARTICLES_PER_LANG = 50;

export interface E7Candidate {
  articleId: string;
  lang: string;
  /** Raters who rated the article (development pairs of the E1 cohort). */
  raterIds: readonly string[];
}

export interface E7Item {
  articleId: string;
  lang: string;
  raterId: string;
  /** The rater's positive card with the lowest E1 p (ties to the lowest id). */
  targetedCardId: string;
  /** The interest text E1 sent for that card (as written). */
  targetedInterest: string;
}

/** A value in [0, 1) from a seeded hash (deterministic order and choices). */
function rank(seed: string, value: string): number {
  return Number.parseInt(sha256Hex(`${seed}\u0000${value}`).slice(0, 13), 16) / 2 ** 52;
}

/** The rater of an article, chosen by a hash seeded with the article id. */
export function e7Rater(articleId: string, raterIds: readonly string[]): string | null {
  const sorted = [...new Set(raterIds)].sort(compareBigIntStrings);
  if (sorted.length === 0) return null;
  const index = Math.floor(rank('e7.rater', articleId) * sorted.length);
  return sorted[Math.min(index, sorted.length - 1)] ?? null;
}

export function planE7(input: {
  seed: string;
  candidates: readonly E7Candidate[];
  cardsByRater: ReadonlyMap<string, readonly RunCard[]>;
  /** E1's card answers: article id → card id → p. */
  answers: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** One rater's answers when they differ from the shared ones (`card.r<raterId>`, D-112). */
  answersOf?: (raterId: string, articleId: string) => ReadonlyMap<string, number> | undefined;
  perLang?: number;
}): E7Item[] {
  const perLang = input.perLang ?? E7_ARTICLES_PER_LANG;
  const answersOf =
    input.answersOf ?? ((_raterId: string, articleId: string) => input.answers.get(articleId));
  // Each candidate's item is resolved first: the rater E7 picks (independent of the answers) and
  // that rater's answered positive card with the lowest p. Only targetable items compete for the
  // seeded `perLang` slots, so a candidate without one never displaces a valid one.
  const byLang = new Map<string, E7Item[]>();
  for (const candidate of input.candidates) {
    const raterId = e7Rater(candidate.articleId, candidate.raterIds);
    if (raterId === null) continue;
    const answers = answersOf(raterId, candidate.articleId);
    let target: { card: RunCard; p: number } | null = null;
    for (const card of input.cardsByRater.get(raterId) ?? []) {
      if (!isPositiveStrength(card.strength)) continue;
      const p = answers?.get(card.cardId);
      if (p === undefined) continue;
      if (
        target === null ||
        p < target.p ||
        (p === target.p && compareBigIntStrings(card.cardId, target.card.cardId) < 0)
      ) {
        target = { card, p };
      }
    }
    if (target === null) continue;
    const list = byLang.get(candidate.lang) ?? [];
    list.push({
      articleId: candidate.articleId,
      lang: candidate.lang,
      raterId,
      targetedCardId: target.card.cardId,
      targetedInterest: target.card.interest,
    });
    byLang.set(candidate.lang, list);
  }
  const items: E7Item[] = [];
  for (const lang of [...byLang.keys()].sort()) {
    items.push(
      ...(byLang.get(lang) ?? [])
        .map((item) => ({ item, r: rank(input.seed, item.articleId) }))
        .sort((a, b) => a.r - b.r || compareBigIntStrings(a.item.articleId, b.item.articleId))
        .slice(0, perLang)
        .map(({ item }) => item),
    );
  }
  return items;
}
