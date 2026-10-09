import { describe, expect, it } from 'vitest';

import { formatProbability } from '../../src/features/article/format.js';
import { httpUrl } from '../../src/features/article/http-url.js';

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
