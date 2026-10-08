import type { IdChange } from '@bantoozi/shared';

import { onAccountReset } from '../../session/reset.js';

/**
 * Where the cards of each account went. A card is immutable, so changing one gives it a new id; a
 * surface that was told the old id (an explanation, a suggestion) asks here for the current one.
 * The moves are kept for the length of the account's session and dropped with it.
 */
const moves = new Map<string, Map<string, string>>();

/** `from` is now `to`, and so is everything that already led to `from`. */
export function recordCardMove(accountId: string, { from, to }: IdChange): void {
  let own = moves.get(accountId);
  if (own === undefined) {
    own = new Map();
    moves.set(accountId, own);
  }
  for (const [stored, current] of own) {
    if (current === from) own.set(stored, to);
  }
  own.set(from, to);
}

/** The id the card that was known as `storedId` goes by now. */
export function currentCardId(accountId: string, storedId: string): string {
  return moves.get(accountId)?.get(storedId) ?? storedId;
}

export function forgetCardMoves(): void {
  moves.clear();
}

onAccountReset(forgetCardMoves);
