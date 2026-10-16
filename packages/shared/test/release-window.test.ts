import { describe, expect, it } from 'vitest';
import { releaseWindow } from '../src/release-window.js';

function window(now: string, zone: string, interval: number | null) {
  const result = releaseWindow(new Date(now), zone, interval);
  return [result.releasedAt.toISOString(), result.nextReleaseAt?.toISOString() ?? null];
}

describe('plan releases in the reader time zone', () => {
  it('aligns six-hour and beta windows to local wall time', () => {
    expect(window('2026-10-16T10:37:12Z', 'Europe/Bratislava', 21600)).toEqual([
      '2026-10-16T10:00:00.000Z',
      '2026-10-16T16:00:00.000Z',
    ]);
    expect(window('2026-10-16T10:37:12Z', 'Europe/Bratislava', 900)).toEqual([
      '2026-10-16T10:30:00.000Z',
      '2026-10-16T10:45:00.000Z',
    ]);
  });
  it('honors fractional-hour offsets and local date rollover', () => {
    expect(window('2026-10-16T10:37:12Z', 'Asia/Kathmandu', 21600)).toEqual([
      '2026-10-16T06:15:00.000Z',
      '2026-10-16T12:15:00.000Z',
    ]);
    expect(window('2026-10-16T02:00:00Z', 'Pacific/Honolulu', 21600)).toEqual([
      '2026-10-15T22:00:00.000Z',
      '2026-10-16T04:00:00.000Z',
    ]);
  });
  it('releases each repeated hourly boundary in autumn', () => {
    expect(window('2026-10-25T00:30:00Z', 'Europe/Bratislava', 3600)).toEqual([
      '2026-10-25T00:00:00.000Z',
      '2026-10-25T01:00:00.000Z',
    ]);
    expect(window('2026-10-25T01:30:00Z', 'Europe/Bratislava', 3600)).toEqual([
      '2026-10-25T01:00:00.000Z',
      '2026-10-25T02:00:00.000Z',
    ]);
  });
  it('finds the next beta release when the wall clock moves backwards', () => {
    expect(window('2026-10-25T00:50:00Z', 'Europe/Bratislava', 900)).toEqual([
      '2026-10-25T00:45:00.000Z',
      '2026-10-25T01:00:00.000Z',
    ]);
    expect(window('2026-10-25T01:05:00Z', 'Europe/Bratislava', 900)).toEqual([
      '2026-10-25T01:00:00.000Z',
      '2026-10-25T01:15:00.000Z',
    ]);
  });
  it('skips a nonexistent spring boundary and keeps six-hour wall times', () => {
    expect(window('2026-03-29T00:30:00Z', 'Europe/Bratislava', 3600)).toEqual([
      '2026-03-29T00:00:00.000Z',
      '2026-03-29T01:00:00.000Z',
    ]);
    expect(window('2026-03-29T01:30:00Z', 'Europe/Bratislava', 21600)).toEqual([
      '2026-03-28T23:00:00.000Z',
      '2026-03-29T04:00:00.000Z',
    ]);
    expect(window('2026-10-25T01:30:00Z', 'Europe/Bratislava', 21600)).toEqual([
      '2026-10-24T22:00:00.000Z',
      '2026-10-25T05:00:00.000Z',
    ]);
  });
  it('handles half-hour daylight-saving changes and exact boundaries', () => {
    const now = new Date('2026-10-04T15:00:00Z');
    const result = releaseWindow(now, 'Australia/Lord_Howe', 60);
    expect(result.releasedAt).toEqual(now);
    expect(result.nextReleaseAt!.getTime() - now.getTime()).toBe(60000);
  });
  it('supports immediate plans and rejects invalid intervals', () => {
    expect(window('2026-10-16T10:37:12Z', 'UTC', null)).toEqual(['2026-10-16T10:37:12.000Z', null]);
    expect(() => releaseWindow(new Date(), 'UTC', 12)).toThrow(RangeError);
  });
});
