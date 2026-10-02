import { describe, expect, it } from 'vitest';

import { MAX_ASSIGNMENT_TARGET, ServeRatingOptionsSchema } from '../src/commands/serve-rating.js';
import { ASSIGNMENTS_PER_RATER } from '../src/rating-server/assignments.js';

/** D-146: `eval serve-rating --assignments <n>` sets the per-context assignment target. */
describe('serve-rating options', () => {
  it('defaults to 300 assignments and port 5180', () => {
    expect(ServeRatingOptionsSchema.parse({})).toEqual({
      port: 5180,
      assignments: ASSIGNMENTS_PER_RATER,
    });
  });

  it('accepts a whole number from 1 to the maximum', () => {
    expect(ServeRatingOptionsSchema.parse({ assignments: '450' }).assignments).toBe(450);
    expect(
      ServeRatingOptionsSchema.parse({ assignments: String(MAX_ASSIGNMENT_TARGET) }).assignments,
    ).toBe(MAX_ASSIGNMENT_TARGET);
    for (const bad of ['0', '-5', '12.5', 'many', String(MAX_ASSIGNMENT_TARGET + 1)]) {
      expect(ServeRatingOptionsSchema.safeParse({ assignments: bad }).success).toBe(false);
    }
  });
});
