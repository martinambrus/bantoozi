import { describe, expect, it } from 'vitest';

import { BODY_LEAD_MAX_CHARS, bodyLead, countWords } from '../../src/extract/index.js';

const chars = (text: string): number => Array.from(text).length;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('spec 03 §8.1 step 6 bodyLead', () => {
  it('returns a text that fits whole, trimmed', () => {
    expect(bodyLead('  A short article. Without a cut  ')).toBe('A short article. Without a cut');
    expect(bodyLead('')).toBe('');
    const exact = 'x'.repeat(BODY_LEAD_MAX_CHARS);
    expect(bodyLead(exact)).toBe(exact);
  });

  it('cuts at the last sentence end after character 1,000', () => {
    const text = `${'a'.repeat(1100)}. ${'b'.repeat(200)}! ${'c'.repeat(600)}`;
    const lead = bodyLead(text);
    expect(lead).toBe(`${'a'.repeat(1100)}. ${'b'.repeat(200)}!`);
    expect(chars(lead)).toBe(1303);
  });

  it.each(['.', '!', '?', '…'])('treats %s as a sentence end', (end) => {
    const text = `${'a'.repeat(1200)}${end} ${'b'.repeat(500)}`;
    expect(bodyLead(text)).toBe(`${'a'.repeat(1200)}${end}`);
  });

  it('ignores sentence ends at or before character 1,000 and cuts hard at 1,500', () => {
    const text = `${'a'.repeat(999)}. ${'b'.repeat(700)}`;
    const lead = bodyLead(text);
    expect(chars(lead)).toBe(BODY_LEAD_MAX_CHARS);
    expect(text.startsWith(lead)).toBe(true);

    const justAfter = `${'a'.repeat(1000)}. ${'b'.repeat(700)}`;
    expect(bodyLead(justAfter)).toBe(`${'a'.repeat(1000)}.`);
  });

  it('keeps closing quotes and brackets with their sentence', () => {
    const slovak = `${'a'.repeat(1100)}, povedal: „Áno.“ ${'b'.repeat(600)}`;
    expect(bodyLead(slovak).endsWith('„Áno.“')).toBe(true);
    const bracket = `${'a'.repeat(1100)} (see below!) ${'b'.repeat(600)}`;
    expect(bodyLead(bracket).endsWith('(see below!)')).toBe(true);
  });

  it('does not cut inside numbers, domains or abbreviations without a following space', () => {
    const text = `${'a '.repeat(560)}rose 3.5 percent at example.com${'x'.repeat(600)}`;
    const lead = bodyLead(text);
    expect(chars(lead)).toBeLessThanOrEqual(BODY_LEAD_MAX_CHARS);
    expect(lead.endsWith('3.')).toBe(false);
    expect(lead.endsWith('example.')).toBe(false);
  });

  it('accepts a sentence end on the last allowed character and trims a hard cut', () => {
    const lastChar = `${'a'.repeat(1499)}. ${'b'.repeat(10)}`;
    expect(bodyLead(lastChar)).toBe(`${'a'.repeat(1499)}.`);
    const glued = `${'a'.repeat(1499)}.b${'c'.repeat(10)}`;
    expect(chars(bodyLead(glued))).toBe(BODY_LEAD_MAX_CHARS);
    const spaced = `${'a'.repeat(1498)}  ${'b'.repeat(10)}`;
    expect(bodyLead(spaced)).toBe('a'.repeat(1498));
  });

  it('counts code points, never splitting a surrogate pair', () => {
    const emoji = '😀'.repeat(2000);
    const lead = bodyLead(emoji);
    expect(chars(lead)).toBe(BODY_LEAD_MAX_CHARS);
    expect(LONE_SURROGATE.test(lead)).toBe(false);
  });

  it('always yields a trimmed prefix of at most 1,500 characters', () => {
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const alphabet = ['a', 'b', ' ', '.', '!', '?', '…', '\n', '„', '“', 'ľ', '😀', '3'];
    for (let round = 0; round < 50; round += 1) {
      const length = Math.floor(random() * 3000);
      const text = Array.from(
        { length },
        () => alphabet[Math.floor(random() * alphabet.length)],
      ).join('');
      const lead = bodyLead(text);
      expect(chars(lead)).toBeLessThanOrEqual(BODY_LEAD_MAX_CHARS);
      expect(text.trim().startsWith(lead)).toBe(true);
      expect(LONE_SURROGATE.test(lead)).toBe(false);
    }
  });
});

describe('spec 03 §8.1 step 6 countWords', () => {
  it.each([
    ['', 0],
    ['   \n\t ', 0],
    ['one', 1],
    [' one  two\tthree\nfour ', 4],
    ['First paragraph.\n\nSecond paragraph.', 4],
    ['Hello, world!', 2],
    ['v Bratislave', 2],
    ['— a dash —', 4],
    ['😀 😀😀', 2],
  ])('%j has %i words', (text, words) => {
    expect(countWords(text)).toBe(words);
  });
});
