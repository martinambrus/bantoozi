import { murmur3 } from './murmur3.js';

/** Deterministic uniform [0, 1) generator seeded from a string (murmur3 hash, then mulberry32). */
export function seededRandom(seed: string): () => number {
  let s = murmur3(seed) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
