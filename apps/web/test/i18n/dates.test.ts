import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  formatDate,
  formatDateTime,
  formatRelativeTime,
  formatTime,
} from '../../src/i18n/dates.js';
import { FAR_ZONE } from '../support/zones.js';

const T = '2026-06-01T12:00:00.000Z';
const BRATISLAVA = 'Europe/Bratislava';
const plain = (text: string) => text.replace(/\s/g, ' ');

afterEach(() => {
  vi.restoreAllMocks();
});

/** The module as a page that has just loaded sees it, with nothing cached yet. */
async function freshDates() {
  vi.resetModules();
  return import('../../src/i18n/dates.js');
}

describe('formatDateTime', () => {
  it.each([
    ['en', 'UTC', 'Jun 1, 2026, 12:00 PM'],
    ['en', BRATISLAVA, 'Jun 1, 2026, 2:00 PM'],
    ['en', 'America/New_York', 'Jun 1, 2026, 8:00 AM'],
    ['en', FAR_ZONE, 'Jun 2, 2026, 2:00 AM'],
    ['sk', 'UTC', '1. 6. 2026, 12:00'],
    ['sk', BRATISLAVA, '1. 6. 2026, 14:00'],
    ['sk', FAR_ZONE, '2. 6. 2026, 2:00'],
  ])('writes the moment in %s and the zone %s as "%s"', (language, zone, text) => {
    expect(plain(formatDateTime(T, language, zone))).toBe(text);
  });

  it('takes the moment as milliseconds too', () => {
    expect(formatDateTime(Date.parse(T), 'en', FAR_ZONE)).toBe(formatDateTime(T, 'en', FAR_ZONE));
  });

  it('writes nothing for a moment that does not parse', () => {
    expect(formatDateTime('soon', 'en', 'UTC')).toBe('');
    expect(formatDateTime(Number.NaN, 'en', 'UTC')).toBe('');
    expect(formatDateTime('', 'sk', 'UTC')).toBe('');
  });
});

describe('formatDate', () => {
  it.each([
    ['en', 'UTC', 'Jun 1, 2026'],
    ['en', FAR_ZONE, 'Jun 2, 2026'],
    ['sk', 'UTC', '1. 6. 2026'],
    ['sk', FAR_ZONE, '2. 6. 2026'],
  ])('writes the day in %s and the zone %s as "%s"', (language, zone, text) => {
    expect(formatDate(T, language, zone)).toBe(text);
  });

  it('puts a moment near midnight on the day of the zone', () => {
    expect(formatDate('2026-10-01T22:30:00.000Z', 'en', BRATISLAVA)).toBe('Oct 2, 2026');
    expect(formatDate('2026-10-01T22:30:00.000Z', 'en', 'UTC')).toBe('Oct 1, 2026');
  });

  it('writes nothing for a moment that does not parse', () => {
    expect(formatDate('soon', 'en', 'UTC')).toBe('');
    expect(formatDate(Number.NaN, 'sk', 'UTC')).toBe('');
  });
});

describe('formatTime', () => {
  it.each([
    ['en', 'UTC', '12:00 PM'],
    ['en', BRATISLAVA, '2:00 PM'],
    ['sk', BRATISLAVA, '14:00'],
    ['sk', FAR_ZONE, '2:00'],
  ])('writes the time of day in %s and the zone %s as "%s"', (language, zone, text) => {
    expect(plain(formatTime(T, language, zone))).toBe(text);
  });

  it('writes nothing for a moment that does not parse', () => {
    expect(formatTime('soon', 'en', 'UTC')).toBe('');
  });
});

describe('a time zone the browser does not know', () => {
  const device = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en', options).format(new Date(T));

  it('is replaced by the zone of the device, for every kind of moment', () => {
    expect(formatDateTime(T, 'en', 'Mars/Olympus_Mons')).toBe(
      device({ dateStyle: 'medium', timeStyle: 'short' }),
    );
    expect(formatDate(T, 'en', 'Mars/Olympus_Mons')).toBe(device({ dateStyle: 'medium' }));
    expect(formatTime(T, 'en', '')).toBe(device({ timeStyle: 'short' }));
  });

  it('is looked up once, not on every call', async () => {
    const dates = await freshDates();
    const construct = vi.spyOn(Intl, 'DateTimeFormat');

    dates.formatDateTime(T, 'en', 'Mars/Olympus_Mons');
    const first = construct.mock.calls.length;
    dates.formatDateTime(T, 'en', 'Mars/Olympus_Mons');
    dates.formatDateTime('2026-07-01T00:00:00.000Z', 'en', 'Mars/Olympus_Mons');

    expect(first).toBeGreaterThan(0);
    expect(construct).toHaveBeenCalledTimes(first);
  });
});

describe('the formatters of the moments', () => {
  it('are built once for a language, a zone and a kind of moment', async () => {
    const dates = await freshDates();
    const construct = vi.spyOn(Intl, 'DateTimeFormat');

    for (const at of [T, '2026-07-01T00:00:00.000Z', Date.parse(T)]) {
      dates.formatDateTime(at, 'en', 'Asia/Tokyo');
    }
    expect(construct).toHaveBeenCalledTimes(1);

    dates.formatDateTime(T, 'sk', 'Asia/Tokyo');
    expect(construct).toHaveBeenCalledTimes(2);
    dates.formatDateTime(T, 'en', 'Asia/Seoul');
    expect(construct).toHaveBeenCalledTimes(3);
    dates.formatDate(T, 'en', 'Asia/Tokyo');
    dates.formatTime(T, 'en', 'Asia/Tokyo');
    expect(construct).toHaveBeenCalledTimes(5);

    dates.formatDate(T, 'en', 'Asia/Tokyo');
    dates.formatTime(T, 'en', 'Asia/Tokyo');
    dates.formatDateTime(T, 'sk', 'Asia/Tokyo');
    expect(construct).toHaveBeenCalledTimes(5);
  });

  it('are not built for a moment that does not parse', async () => {
    const dates = await freshDates();
    const construct = vi.spyOn(Intl, 'DateTimeFormat');

    dates.formatDateTime('soon', 'en', 'Asia/Tokyo');

    expect(construct).not.toHaveBeenCalled();
  });
});

describe('formatRelativeTime', () => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const NOW = Date.parse(T);
  const before = (ms: number) => new Date(NOW - ms).toISOString();

  it.each([
    ['2026-05-31T09:59:40.000Z', 'now', 'teraz'],
    ['2026-05-31T09:55:00.000Z', '5 minutes ago', 'pred 5 minútami'],
    ['2026-05-31T08:30:00.000Z', '1 hour ago', 'pred 1 hodinou'],
    ['2026-05-31T08:00:00.000Z', '2 hours ago', 'pred 2 hodinami'],
    ['2026-05-30T09:00:00.000Z', 'yesterday', 'včera'],
    ['2026-05-28T10:00:00.000Z', '3 days ago', 'pred 3 dňami'],
    ['2026-05-17T10:00:00.000Z', '2 weeks ago', 'pred 2 týždňami'],
    ['2026-01-31T10:00:00.000Z', '4 months ago', 'pred 4 mesiacmi'],
    ['2025-03-01T10:00:00.000Z', 'last year', 'minulý rok'],
    ['2026-05-31T11:00:00.000Z', 'now', 'teraz'],
  ])('writes %s as "%s" in English and "%s" in Slovak', (iso, en, sk) => {
    const now = Date.parse('2026-05-31T10:00:00.000Z');
    expect(formatRelativeTime(iso, now, 'en')).toBe(en);
    expect(formatRelativeTime(iso, now, 'sk')).toBe(sk);
  });

  it.each([
    ['the same instant', 'now', 'teraz', 0],
    ['59.999 seconds', 'now', 'teraz', 59_999],
    ['a minute', '1 minute ago', 'pred 1 minútou', MINUTE],
    ['59 minutes and 59 seconds', '59 minutes ago', 'pred 59 minútami', HOUR - 1_000],
    ['an hour', '1 hour ago', 'pred 1 hodinou', HOUR],
    ['23 hours and 59 minutes', '23 hours ago', 'pred 23 hodinami', DAY - MINUTE],
    ['a day', 'yesterday', 'včera', DAY],
    ['47 hours', 'yesterday', 'včera', 47 * HOUR],
    ['two days', '2 days ago', 'predvčerom', 2 * DAY],
    ['six days and 23 hours', '6 days ago', 'pred 6 dňami', 7 * DAY - HOUR],
    ['a week', 'last week', 'minulý týždeň', 7 * DAY],
    ['two weeks', '2 weeks ago', 'pred 2 týždňami', 14 * DAY],
    ['29 days', '4 weeks ago', 'pred 4 týždňami', 29 * DAY],
    ['30 days', 'last month', 'minulý mesiac', 30 * DAY],
    ['60 days', '2 months ago', 'pred 2 mesiacmi', 60 * DAY],
    ['364 days', '12 months ago', 'pred 12 mesiacmi', 364 * DAY],
    ['365 days', 'last year', 'minulý rok', 365 * DAY],
    ['two years', '2 years ago', 'pred 2 rokmi', 730 * DAY],
  ])('writes %s as "%s" in English and "%s" in Slovak', (_elapsed, en, sk, ms) => {
    expect(formatRelativeTime(before(ms), NOW, 'en')).toBe(en);
    expect(formatRelativeTime(before(ms), NOW, 'sk')).toBe(sk);
  });

  it.each([
    ['a second ahead', 1_000],
    ['an hour ahead', HOUR],
    ['a year ahead', 365 * DAY],
  ])('counts %s, as a publisher clock may be, as now', (_ahead, ms) => {
    const ahead = new Date(NOW + ms).toISOString();
    expect(formatRelativeTime(ahead, NOW, 'en')).toBe('now');
    expect(formatRelativeTime(ahead, NOW, 'sk')).toBe('teraz');
  });

  it('writes nothing for a date that does not parse', () => {
    expect(formatRelativeTime('yesterday-ish', NOW, 'en')).toBe('');
    expect(formatRelativeTime('', NOW, 'sk')).toBe('');
  });

  it('builds one formatter per language', async () => {
    const dates = await freshDates();
    const construct = vi.spyOn(Intl, 'RelativeTimeFormat');

    for (const ms of [0, MINUTE, 3 * HOUR, 40 * DAY]) {
      dates.formatRelativeTime(before(ms), NOW, 'en');
    }
    expect(construct).toHaveBeenCalledTimes(1);

    dates.formatRelativeTime(before(HOUR), NOW, 'sk');
    dates.formatRelativeTime(before(DAY), NOW, 'sk');
    expect(construct).toHaveBeenCalledTimes(2);
  });
});
