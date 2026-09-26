import { describe, expect, it } from 'vitest';

import { parseCacheMaxAge, syPeriodSeconds } from '../../src/schedule/index.js';

describe('syPeriodSeconds (spec 03 §9)', () => {
  it.each([
    ['hourly', 1, 3600],
    ['daily', 1, 86_400],
    ['weekly', 1, 604_800],
    ['monthly', 1, 2_592_000],
    ['yearly', 1, 31_536_000],
    ['daily', 2, 43_200],
    ['hourly', 4, 900],
    ['weekly', 7, 86_400],
    ['daily', 0.5, 172_800],
  ])('%s ÷ %s is %i s', (period, frequency, expected) => {
    expect(syPeriodSeconds(period, frequency)).toBe(expected);
  });

  it('treats a missing frequency as 1, the syndication module default', () => {
    expect(syPeriodSeconds('daily', null)).toBe(86_400);
    expect(syPeriodSeconds('daily', undefined)).toBe(86_400);
  });

  it('matches the period case-insensitively after trimming', () => {
    expect(syPeriodSeconds(' Daily\n', 1)).toBe(86_400);
    expect(syPeriodSeconds('WEEKLY', 2)).toBe(302_400);
  });

  it.each<[string | null | undefined, number | null | undefined]>([
    [null, 1],
    [undefined, 1],
    [undefined, undefined],
    ['', 1],
    ['fortnightly', 1],
    ['daily', 0],
    ['daily', -1],
    ['daily', Number.NaN],
    ['daily', Number.POSITIVE_INFINITY],
    ['daily', Number.NEGATIVE_INFINITY],
  ])('gives no hint for period %j and frequency %s', (period, frequency) => {
    expect(syPeriodSeconds(period, frequency)).toBeNull();
  });
});

describe('parseCacheMaxAge (spec 03 §9)', () => {
  it.each([
    ['max-age=3600', 3600],
    ['public, max-age=600', 600],
    ['max-age=600, must-revalidate', 600],
    ['MAX-AGE=60', 60],
    ['Max-Age="120"', 120],
    ['max-age = 60', 60],
    ['max-age=0', 0],
    ['max-age=0060', 60],
    ['s-maxage=100, max-age=50', 50],
    ['private="a,max-age=5", max-age=30', 30],
    ['no-cache="x\\",max-age=5", max-age=30', 30],
    ['max-age=60, max-age=60', 60],
    ['max-age=99999999999999', 2 ** 31],
  ])('reads %j as %i s', (header, expected) => {
    expect(parseCacheMaxAge(header)).toBe(expected);
  });

  it.each([
    undefined,
    null,
    '',
    'no-cache',
    'no-store, private',
    's-maxage=100',
    'max-agex=60',
    'max-age',
    'max-age=',
    'max-age=-1',
    'max-age=1.5',
    'max-age=abc',
    'max-age=60s',
    'max-age="60',
    'max-age=60, max-age=120',
    'max-age=abc, max-age=60',
  ])('finds no valid max-age in %j', (header) => {
    expect(parseCacheMaxAge(header)).toBeNull();
  });
});
