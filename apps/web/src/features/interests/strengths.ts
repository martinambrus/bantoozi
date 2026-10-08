import type { CardDto } from '@bantoozi/shared';

export type Strength = CardDto['strength'];

export const STRENGTHS: readonly Strength[] = ['must', 'love', 'like', 'never'];

export const DEFAULT_STRENGTH: Strength = 'like';

export function isStrength(value: string): value is Strength {
  return (STRENGTHS as readonly string[]).includes(value);
}
