const C1 = 0xcc9e2d51;
const C2 = 0x1b873593;
const encoder = new TextEncoder();

function mixK(k: number): number {
  const scrambled = Math.imul(k, C1);
  return Math.imul((scrambled << 15) | (scrambled >>> 17), C2);
}

/**
 * MurmurHash3 x86 32-bit over the UTF-8 bytes of `text` (spec 06 §8.1): the stable hash behind the
 * feed and author buckets of `FEATURE_SPEC_V1`. Returns an unsigned 32-bit integer.
 */
export function murmur3(text: string, seed = 0): number {
  const bytes = encoder.encode(text);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = bytes.length;
  const blockEnd = length - (length % 4);
  let h = seed >>> 0;
  for (let i = 0; i < blockEnd; i += 4) {
    h ^= mixK(view.getUint32(i, true));
    h = (Math.imul((h << 13) | (h >>> 19), 5) + 0xe6546b64) | 0;
  }
  const tail = length % 4;
  if (tail > 0) {
    let k = 0;
    if (tail >= 3) k ^= (bytes[blockEnd + 2] ?? 0) << 16;
    if (tail >= 2) k ^= (bytes[blockEnd + 1] ?? 0) << 8;
    k ^= bytes[blockEnd] ?? 0;
    h ^= mixK(k);
  }
  h ^= length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
