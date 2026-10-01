import { sha256Hex } from '@bantoozi/shared/server';

/**
 * A seeded pseudo-random source (spec 01 §5: injected randomness), so every bootstrap interval is
 * reproducible from its seed. mulberry32 seeded from the SHA-256 of the seed text: small, fast and
 * statistically adequate for resampling indices; not for anything secret.
 */
export interface Rng {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [0, n). */
  int(n: number): number;
}

export function createRng(seed: string | number): Rng {
  let state = Number.parseInt(sha256Hex(`bootstrap\u0000${String(seed)}`).slice(0, 8), 16) >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n) => {
      if (!Number.isInteger(n) || n <= 0) throw new RangeError('n must be a positive integer');
      return Math.floor(next() * n);
    },
  };
}
