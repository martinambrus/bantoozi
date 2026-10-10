import { describe, expect, it } from 'vitest';

import { murmur3 } from '../../src/index.js';

describe('murmur3 (MurmurHash3 x86 32-bit over UTF-8 bytes, spec 06 §8.1)', () => {
  it.each([
    ['the empty string', '', 0x00000000],
    ['four NUL bytes', '\0\0\0\0', 0x2362f9de],
    ['a one-byte tail', 'a', 0x3c2569b2],
    ['a block without tail', 'test', 0xba6bd213],
    ['a three-byte tail', 'Hello, world!', 0xc0363e43],
    ['a pangram', 'The quick brown fox jumps over the lazy dog', 0x2e4ff723],
    ['the decimal id 1', '1', 0x9416ac93],
    ['the decimal id 42', '42', 0xbc58a436],
    ['multi-byte UTF-8 characters', 'žluťoučký kůň', 0x5f784569],
  ])('seed 0: %s', (_name, text, expected) => {
    expect(murmur3(text)).toBe(expected);
    expect(murmur3(text, 0)).toBe(expected);
  });

  it.each([
    ['aaaa', 0x9747b28c, 0x5a97808a],
    ['ππππππππ', 0x9747b28c, 0xd58063c1],
  ])('seed 0x9747b28c: %s', (text, seed, expected) => {
    expect(murmur3(text, seed)).toBe(expected);
  });

  it('returns an unsigned 32-bit integer', () => {
    for (const text of ['', 'a', '57', 'Ján Novák', 'x'.repeat(1000)]) {
      const hash = murmur3(text);
      expect(Number.isInteger(hash)).toBe(true);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('hashes the UTF-8 bytes, not UTF-16 code units', () => {
    expect(murmur3('ππππππππ', 0x9747b28c)).toBe(0xd58063c1);
    expect(murmur3('žluťoučký kůň')).not.toBe(murmur3('zlutoucky kun'));
  });
});
