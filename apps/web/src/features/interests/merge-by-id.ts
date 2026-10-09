import type { IdChange } from '@bantoozi/shared';

/**
 * Puts the answer of a card or label mutation into a cached list. Cards are immutable, so an edit
 * can move the holding to another id: the new item takes the old one's place, and when the holder
 * already had the target the two become one, at the target's own position.
 */
export function mergeById<T extends { id: string }>(
  items: readonly T[],
  item: T,
  idChange: IdChange | null,
): T[] {
  const from = idChange?.from ?? item.id;
  const target = items.findIndex((candidate) => candidate.id === item.id);
  if (target !== -1 && from !== item.id) {
    return items.flatMap((candidate, index) =>
      index === target ? [item] : candidate.id === from ? [] : [candidate],
    );
  }
  const position = items.findIndex((candidate) => candidate.id === from);
  if (position === -1) return [...items, item];
  return items.map((candidate, index) => (index === position ? item : candidate));
}
