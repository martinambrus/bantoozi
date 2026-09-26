import { utcDay } from '@bantoozi/shared';

/** Jitter spreads fetches over ±10 % of the interval (spec 03 §9). */
const JITTER_RANGE = 0.1;

/**
 * Deterministic schedule jitter in `[-0.1, 0.1]` from a hash of the feed ID and the UTC day of
 * `now` (spec 03 §9): every fetch of one feed on one UTC day uses the same factor, and feeds that
 * became due together spread out instead of hitting the scheduler in lockstep.
 *
 * The hash is 32-bit FNV-1a over `"<feedId>:<YYYY-MM-DD>"` with the MurmurHash3 `fmix32`
 * finalizer, not `sha256Hex` from `@bantoozi/shared/server`: it is pure, synchronous and free of
 * Node built-ins, which is all jitter needs (it is not a security boundary). The finalizer gives
 * full avalanche, so neighbouring days and feed IDs get unrelated factors. Changing the hash
 * reshuffles every feed's schedule once; the unit tests pin known values.
 *
 * @throws RangeError when `now` is an invalid `Date`.
 */
export function scheduleJitter(feedId: string, now: Date): number {
  const unit = hash32(`${feedId}:${utcDay(now)}`) / 0xffff_ffff;
  return (unit * 2 - 1) * JITTER_RANGE;
}

/** 32-bit FNV-1a over UTF-16 code units, then MurmurHash3 `fmix32`; an unsigned integer. */
function hash32(input: string): number {
  let h = 0x811c_9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x0100_0193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85eb_ca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2_ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
