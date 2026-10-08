import { describe, expect, it } from 'vitest';

import { createdComment, E2E_STALE_AFTER_MS, parseCreatedComment } from '../src/e2e/database.js';

describe('the creation comment of an E2E database', () => {
  it('round-trips the creation time', () => {
    const at = new Date('2026-03-10T12:34:56.789Z');
    expect(createdComment(at)).toBe('bantoozi-e2e created 2026-03-10T12:34:56.789Z');
    expect(parseCreatedComment(createdComment(at))).toEqual(at);
  });

  it.each([
    null,
    '',
    'bantoozi-template-ready',
    'bantoozi-e2e created',
    'bantoozi-e2e created yesterday',
    'created 2026-03-10T12:34:56.789Z',
    ' bantoozi-e2e created 2026-03-10T12:34:56.789Z',
  ])('ignores the comment %j', (comment) => {
    expect(parseCreatedComment(comment)).toBeUndefined();
  });

  it('treats a database as stale after six hours', () => {
    expect(E2E_STALE_AFTER_MS).toBe(6 * 60 * 60 * 1000);
  });
});
