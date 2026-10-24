import { MODEL_PROBE_MAX_AGE_MS, MODEL_PROBE_MAX_SKEW_MS } from '@bantoozi/shared';
import { describe, expect, it } from 'vitest';

import * as resolution from '../src/model-resolution.js';

/**
 * N1: the truth table of `resolutionInForce`. A stored resolution is dormant only when the pin is
 * not alias-marked, names another model, and the row was not confirmed within the probe window.
 */
const NOW = Date.parse('2026-10-20T10:00:00.000Z');
const MIN = 60_000;
const at = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

const row = (checkedAt: string, model = 'jev-1.14.0') => ({
  alias: 'jev-latest' as const,
  model,
  resolvedAt: checkedAt,
  checkedAt,
});
const pin = (model: string, alias?: 'jev-latest') => ({
  model,
  since: '2026-10-01T00:00:00.000Z',
  ...(alias === undefined ? {} : { alias }),
});

const OLD = at(-10 * 24 * 60 * MIN);

describe('resolutionInForce', () => {
  const cases: [string, ReturnType<typeof row>, ReturnType<typeof pin> | null, boolean][] = [
    ['no pin, old row', row(OLD), null, true],
    ['no pin, fresh row', row(at(-MIN)), null, true],
    [
      'alias-marked pin, other model, old row (flip in flight)',
      row(OLD),
      pin('jev-1.13.0', 'jev-latest'),
      true,
    ],
    ['unmarked pin, same model, old row', row(OLD), pin('jev-1.14.0'), true],
    ['unmarked pin, other model, row 1 min old', row(at(-MIN)), pin('jev-1.13.0'), true],
    [
      'unmarked pin, other model, row exactly at the max age',
      row(at(-MODEL_PROBE_MAX_AGE_MS)),
      pin('jev-1.13.0'),
      true,
    ],
    [
      'unmarked pin, other model, row 1 ms past the max age',
      row(at(-MODEL_PROBE_MAX_AGE_MS - 1)),
      pin('jev-1.13.0'),
      false,
    ],
    ['unmarked pin, other model, old row', row(OLD), pin('jev-1.13.0'), false],
    [
      'unmarked pin, other model, row at the future skew limit',
      row(at(MODEL_PROBE_MAX_SKEW_MS)),
      pin('jev-1.13.0'),
      true,
    ],
    [
      'unmarked pin, other model, row past the future skew limit',
      row(at(MODEL_PROBE_MAX_SKEW_MS + 1)),
      pin('jev-1.13.0'),
      false,
    ],
    ['unmarked pin, other model, checkedAt NaN', row('not a date'), pin('jev-1.13.0'), false],
    [
      'alias-marked pin, other model, checkedAt NaN',
      row('not a date'),
      pin('jev-1.13.0', 'jev-latest'),
      true,
    ],
    ['no pin, checkedAt NaN', row('not a date'), null, true],
  ];

  it.each(cases)('%s -> %s', (_name, stored, current, expected) => {
    expect(resolution.resolutionInForce(stored, current, NOW)).toBe(expected);
  });

  it('takes a Date as well as milliseconds', () => {
    expect(resolution.resolutionInForce(row(OLD), pin('jev-1.13.0'), new Date(NOW))).toBe(false);
  });
});
