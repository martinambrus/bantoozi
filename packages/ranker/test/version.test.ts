import { describe, expect, it } from 'vitest';

import { isRankCurrent, RANKER_VERSION, scoreVersion } from '../src/index.js';

describe('scoreVersion (spec 06 §7)', () => {
  it('joins RANKER_VERSION and the settings version with a colon', () => {
    expect(RANKER_VERSION).toMatch(/^[1-9]\d*$/);
    expect(scoreVersion(0)).toBe(`${RANKER_VERSION}:0`);
    expect(scoreVersion(10)).toBe(`${RANKER_VERSION}:10`);
    expect(scoreVersion(10_000)).toBe(`${RANKER_VERSION}:10000`);
  });

  it('serializes a number, a bigint and a decimal string alike', () => {
    expect(scoreVersion(12n)).toBe(scoreVersion(12));
    expect(scoreVersion('12')).toBe(scoreVersion(12));
    expect(scoreVersion('9223372036854775807')).toBe(`${RANKER_VERSION}:9223372036854775807`);
  });

  it('never equals the column default of a row that was never ranked', () => {
    expect(scoreVersion(0)).not.toBe('0:0');
  });

  it('keeps global versions collision-free where plain concatenation would collide', () => {
    expect(`1${'10'}`).toBe(`11${'0'}`);
    expect(scoreVersion(10, '1')).toBe('1:10');
    expect(scoreVersion(0, '11')).toBe('11:0');
    const pairs = new Set<string>();
    const keys = new Set<string>();
    for (let ranker = 1; ranker <= 60; ranker += 1) {
      for (let settings = 0; settings <= 12_000; settings += 7) {
        pairs.add(`${ranker}/${settings}`);
        keys.add(scoreVersion(settings, String(ranker)));
      }
    }
    expect(keys.size).toBe(pairs.size);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, -1n])(
    'rejects the settings version %s',
    (version) => {
      expect(() => scoreVersion(version)).toThrow(RangeError);
    },
  );

  it.each(['', '01', '-1', '1.0', ' 1', '1e3', 'abc', '9223372036854775808'])(
    'rejects the settings version string %j',
    (version) => {
      expect(() => scoreVersion(version)).toThrow(RangeError);
    },
  );

  it.each(['0', '', '01', '1:2', 'v1', '1.1', '-1'])('rejects the ranker version %j', (ranker) => {
    expect(() => scoreVersion(1, ranker)).toThrow(RangeError);
  });
});

describe('isRankCurrent (spec 06 §7)', () => {
  const current = { currentScoreVersion: scoreVersion(3), userRankRevision: '7' };

  it('accepts a row stamped with the current score version and rank revision', () => {
    expect(isRankCurrent({ scoreVersion: scoreVersion(3), rankRevision: '7' }, current)).toBe(true);
    expect(isRankCurrent({ scoreVersion: scoreVersion(3), rankRevision: 7n }, current)).toBe(true);
    expect(
      isRankCurrent(
        { scoreVersion: scoreVersion(3), rankRevision: '7' },
        { currentScoreVersion: scoreVersion(3), userRankRevision: 7n },
      ),
    ).toBe(true);
  });

  it('rejects rows of any other settings or ranker version, older or newer', () => {
    for (const stale of [scoreVersion(2), scoreVersion(4), scoreVersion(3, '2'), '0:0']) {
      expect(isRankCurrent({ scoreVersion: stale, rankRevision: '7' }, current)).toBe(false);
    }
  });

  it('compares versions as text, never by order', () => {
    // '1:10' sorts before '1:9' as text and after it as numbers; only equality counts.
    const ten = { currentScoreVersion: scoreVersion(10, '1'), userRankRevision: '0' };
    expect(isRankCurrent({ scoreVersion: '1:9', rankRevision: '0' }, ten)).toBe(false);
    expect(isRankCurrent({ scoreVersion: '1:10', rankRevision: '0' }, ten)).toBe(true);
    expect(isRankCurrent({ scoreVersion: '11:0', rankRevision: '0' }, ten)).toBe(false);
  });

  it('invalidates every older row after a per-user rank invalidation', () => {
    const bumped = { ...current, userRankRevision: '8' };
    expect(isRankCurrent({ scoreVersion: scoreVersion(3), rankRevision: '7' }, bumped)).toBe(false);
    expect(isRankCurrent({ scoreVersion: scoreVersion(3), rankRevision: 7n }, bumped)).toBe(false);
  });

  it('treats a stored revision above the user’s as outdated too', () => {
    expect(isRankCurrent({ scoreVersion: scoreVersion(3), rankRevision: '8' }, current)).toBe(
      false,
    );
  });

  it('compares rank revisions as bigints, beyond the precision of a JS number', () => {
    expect(Number('9007199254740993')).toBe(Number('9007199254740992'));
    const big = { currentScoreVersion: scoreVersion(3), userRankRevision: '9007199254740993' };
    const stamp = (rankRevision: string | bigint) => ({
      scoreVersion: scoreVersion(3),
      rankRevision,
    });
    expect(isRankCurrent(stamp('9007199254740992'), big)).toBe(false);
    expect(isRankCurrent(stamp(9007199254740993n), big)).toBe(true);
  });

  it('never trusts a missing row or a malformed revision', () => {
    expect(isRankCurrent(null, current)).toBe(false);
    expect(isRankCurrent(undefined, current)).toBe(false);
    for (const revision of ['07', '-7', 'x', '', '7.0', -7n]) {
      expect(
        isRankCurrent({ scoreVersion: scoreVersion(3), rankRevision: revision }, current),
      ).toBe(false);
    }
    const malformedUser = { currentScoreVersion: scoreVersion(3), userRankRevision: 'seven' };
    expect(isRankCurrent({ scoreVersion: scoreVersion(3), rankRevision: '7' }, malformedUser)).toBe(
      false,
    );
  });
});
