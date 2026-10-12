import { describe, expect, it } from 'vitest';

import {
  daysBefore,
  SNAPSHOT_COLD_AFTER_DAYS,
  SNAPSHOT_GRACE_DAYS,
} from '../../src/house/snapshots.js';

describe('snapshot retention clocks (spec 11 §5.2)', () => {
  it('counts whole days back from the injected clock', () => {
    const now = new Date('2026-10-10T12:00:00.000Z');
    expect(daysBefore(now, SNAPSHOT_GRACE_DAYS)).toBe('2026-10-03T12:00:00.000Z');
    expect(daysBefore(now, SNAPSHOT_COLD_AFTER_DAYS)).toBe('2026-09-10T12:00:00.000Z');
  });
});
