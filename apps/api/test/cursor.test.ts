import { createManualClock } from '@bantoozi/shared';
import { describe, expect, it } from 'vitest';

import { createCursorCodec, queryHash } from '../src/services/cursor.js';

const USER = '0190f5c4-1111-7000-8000-000000000001';
const OTHER = '0190f5c4-2222-7000-8000-000000000002';

describe('signed cursors (spec 08 §1 "Pagination")', () => {
  const clock = createManualClock('2026-10-01T00:00:00Z');
  const codec = createCursorCodec('pepper-0123456789abcdef0123456789abcdef', () => clock.now());
  const query = queryHash({ lane: 'for_you', sort: 'score', limit: 30 });

  it('round-trips the sort key, query and extra state', () => {
    const cursor = codec.encode(
      { key: [0.5, '2026-09-30T00:00:00.000Z', '42'], query, extra: { asOf: 'x' } },
      { userId: USER, ttlSeconds: 900 },
    );
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(codec.decode(cursor, { userId: USER, query })).toEqual({
      key: [0.5, '2026-09-30T00:00:00.000Z', '42'],
      query,
      extra: { asOf: 'x' },
    });
  });

  it('rejects another user, another query, tampering, a foreign key and expiry', () => {
    const cursor = codec.encode({ key: [null, '1'], query }, { userId: USER, ttlSeconds: 900 });
    const fail = (c: string, user = USER, q = query) =>
      expect(() => codec.decode(c, { userId: user, query: q })).toThrow(/Invalid cursor/);
    fail(cursor, OTHER);
    fail(cursor, USER, queryHash({ lane: 'maybe' }));
    const [data, mac] = cursor.split('.') as [string, string];
    fail(`${data}x.${mac}`);
    fail(`${data}.${mac.slice(1)}A`);
    fail('garbage');
    fail('');
    const other = createCursorCodec('another-pepper-0123456789abcdef012345', () => clock.now());
    fail(other.encode({ key: [1], query }, { userId: USER, ttlSeconds: 900 }));
    clock.advance(901_000);
    fail(cursor);
  });

  it('normalizes the query hash: key order and undefined values do not matter, cursor is ignored', () => {
    expect(queryHash({ a: 1, b: undefined, cursor: 'x' })).toBe(queryHash({ a: 1 }));
    expect(queryHash({ a: 1, c: 2 })).toBe(queryHash({ c: 2, a: 1 }));
    expect(queryHash({ a: 1 })).not.toBe(queryHash({ a: 2 }));
  });
});
