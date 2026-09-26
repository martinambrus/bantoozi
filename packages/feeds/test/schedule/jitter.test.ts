import { describe, expect, it } from 'vitest';

import { scheduleJitter } from '../../src/schedule/index.js';
import { DAY_MS } from './schedule-fixtures.js';

const DAY = new Date('2026-03-10T00:00:00.000Z');

describe('scheduleJitter (spec 03 §9)', () => {
  it('is pinned for known inputs, so a deploy does not reshuffle schedules', () => {
    expect(scheduleJitter('1', new Date('2026-01-01T00:00:00Z'))).toBe(0.011858283614706778);
    expect(scheduleJitter('42', new Date('2026-03-10T12:00:00Z'))).toBe(0.0018351648239966379);
    expect(scheduleJitter('42', new Date('2026-03-11T12:00:00Z'))).toBe(0.08386450246532087);
    expect(scheduleJitter('9007199254740993', DAY)).toBe(-0.01830045490486092);
  });

  it('depends only on the feed ID and the UTC day of now', () => {
    const jitter = scheduleJitter('42', DAY);
    expect(scheduleJitter('42', new Date('2026-03-10T12:34:56.789Z'))).toBe(jitter);
    expect(scheduleJitter('42', new Date('2026-03-10T23:59:59.999Z'))).toBe(jitter);
    expect(scheduleJitter('42', new Date('2026-03-09T23:30:00-02:00'))).toBe(
      scheduleJitter('42', new Date('2026-03-10T01:30:00Z')),
    );
  });

  it('changes with the day and with the feed', () => {
    const nextDay = new Date(DAY.getTime() + DAY_MS);
    let changedWithDay = 0;
    const values = new Set<number>();
    for (let id = 1; id <= 1000; id += 1) {
      const today = scheduleJitter(String(id), DAY);
      values.add(today);
      if (scheduleJitter(String(id), nextDay) !== today) changedWithDay += 1;
    }
    expect(changedWithDay).toBe(1000);
    expect(values.size).toBe(1000);
  });

  it('stays within ±10 % and spreads evenly', () => {
    const buckets = new Array<number>(10).fill(0);
    let sum = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    const samples = 10_000;
    for (let i = 0; i < samples; i += 1) {
      const jitter = scheduleJitter(
        String(1 + (i % 2000)),
        new Date(DAY.getTime() + Math.floor(i / 2000) * DAY_MS),
      );
      expect(jitter).toBeGreaterThanOrEqual(-0.1);
      expect(jitter).toBeLessThanOrEqual(0.1);
      sum += jitter;
      min = Math.min(min, jitter);
      max = Math.max(max, jitter);
      const bucket = Math.min(9, Math.floor((jitter + 0.1) / 0.02));
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }
    expect(min).toBeLessThan(-0.099);
    expect(max).toBeGreaterThan(0.099);
    expect(Math.abs(sum / samples)).toBeLessThan(0.003);
    for (const count of buckets) {
      expect(count).toBeGreaterThan(900);
      expect(count).toBeLessThan(1100);
    }
  });

  it('rejects an invalid date', () => {
    expect(() => scheduleJitter('42', new Date(Number.NaN))).toThrow(RangeError);
  });
});
