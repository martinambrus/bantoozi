import { describe, expect, it } from 'vitest';

import {
  formatDate,
  formatProbability,
  formatRelativeTime,
} from '../../src/features/article/format.js';
import { httpUrl } from '../../src/features/article/http-url.js';

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-05-31T10:00:00.000Z');

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
    expect(formatRelativeTime(iso, now, 'en')).toBe(en);
    expect(formatRelativeTime(iso, now, 'sk')).toBe(sk);
  });

  it('writes nothing for a date that does not parse', () => {
    expect(formatRelativeTime('yesterday-ish', now, 'en')).toBe('');
  });
});

describe('formatProbability', () => {
  it.each([
    [0.91, '0.91', '0,91'],
    [0.9, '0.90', '0,90'],
    [1, '1.00', '1,00'],
    [0, '0.00', '0,00'],
  ])('writes %s as %s in English and %s in Slovak', (p, en, sk) => {
    expect(formatProbability(p, 'en')).toBe(en);
    expect(formatProbability(p, 'sk')).toBe(sk);
  });
});

describe('formatDate', () => {
  it('writes the day in the language of the reader', () => {
    expect(formatDate('2026-06-01T12:00:00.000Z', 'en')).toBe('Jun 1, 2026');
    expect(formatDate('2026-06-01T12:00:00.000Z', 'sk')).toBe('1. 6. 2026');
  });

  it('writes nothing for a date that does not parse', () => {
    expect(formatDate('soon', 'en')).toBe('');
  });
});

describe('httpUrl', () => {
  it.each(['https://example.test/a?b=1#c', 'http://example.test/', 'HTTPS://EXAMPLE.TEST/A'])(
    'accepts the absolute address %s',
    (value) => {
      expect(httpUrl(value)).toBeInstanceOf(URL);
    },
  );

  it.each([
    null,
    undefined,
    '',
    '/articles/1',
    '//example.test/a',
    'example.test/a',
    'javascript:alert(1)',
    'data:text/html,x',
    'ftp://example.test/a',
    'mailto:a@example.test',
    'not a url',
  ])('rejects %j', (value) => {
    expect(httpUrl(value)).toBeNull();
  });

  it('exposes the host name', () => {
    expect(httpUrl('https://www.example.test:8443/a')?.hostname).toBe('www.example.test');
  });
});
