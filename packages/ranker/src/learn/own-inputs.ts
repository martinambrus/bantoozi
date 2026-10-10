import { compareBigIntStrings } from '@bantoozi/shared';

import type { ReadonlyRankerConfig } from '../config.js';
import { isProbability } from '../lanes.js';
import type { HeldCard } from './model.js';
import type { TrainingSample } from './samples.js';

/**
 * The own card inputs of a training partition (spec 06 §8.1): held cards that, among the partition's
 * explicit samples, had an answer with p ≥ `cardMatchP` at least `cardMinMatched` times, including a
 * like and a dislike. Returns card ids sorted numerically.
 */
export function ownInputs(
  samples: readonly TrainingSample[],
  heldCards: readonly Pick<HeldCard, 'cardId'>[],
  cfg: Pick<ReadonlyRankerConfig, 'model'>,
): string[] {
  const held = new Set(heldCards.map((h) => h.cardId));
  const stats = new Map<string, { matched: number; likes: number; dislikes: number }>();
  for (const s of samples) {
    if (!s.explicit || s.features === null) continue;
    for (const card of s.features.cards) {
      if (!held.has(card.id) || card.engine === 'prefilter') continue;
      if (!isProbability(card.p) || card.p < cfg.model.cardMatchP) continue;
      const st = stats.get(card.id) ?? { matched: 0, likes: 0, dislikes: 0 };
      st.matched += 1;
      if (s.y === 1) st.likes += 1;
      else st.dislikes += 1;
      stats.set(card.id, st);
    }
  }
  const out: string[] = [];
  for (const [id, st] of stats) {
    if (st.matched >= cfg.model.cardMinMatched && st.likes >= 1 && st.dislikes >= 1) out.push(id);
  }
  return out.sort(compareBigIntStrings);
}
