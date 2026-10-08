/** The reader lanes that have their own route (spec 09 §2); `hidden` is the explicit recovery view. */
export const LANES = ['for_you', 'maybe', 'everything', 'new', 'bookmarks', 'hidden'] as const;
export type Lane = (typeof LANES)[number];

export function isLane(value: string): value is Lane {
  return (LANES as readonly string[]).includes(value);
}
