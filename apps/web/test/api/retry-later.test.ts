import { describe, expect, it } from 'vitest';

import { retryLaterMs } from '../../src/api/retry-later.js';

describe('the wait before a try in the background (spec 09 §1)', () => {
  it('is 2 s after the first failure and twice as long after each further one, up to five minutes', () => {
    expect(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 50, 2000].map((failures) => retryLaterMs(failures, null)),
    ).toEqual([
      2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000, 300_000,
    ]);
  });

  it('is never shorter than the Retry-After of the server', () => {
    expect(retryLaterMs(1, 7_000)).toBe(7_000);
    expect(retryLaterMs(3, 7_000)).toBe(8_000);
    expect(retryLaterMs(1, 3_600_000)).toBe(3_600_000);
    expect(retryLaterMs(1, 0)).toBe(2_000);
    expect(retryLaterMs(1, undefined)).toBe(2_000);
  });

  it('is never longer than a timer can hold, which would fire at once', () => {
    expect(retryLaterMs(1, 9_999_999_999_000)).toBe(2 ** 31 - 1);
  });
});
