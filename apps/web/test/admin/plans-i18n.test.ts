import { describe, expect, it } from 'vitest';

import en from '../../src/features/admin/i18n/en.json' with { type: 'json' };
import sk from '../../src/features/admin/i18n/sk.json' with { type: 'json' };

/** D-255: the Plans screen has strings in both languages (same keys under `plans`). */
const keys = (value: unknown, prefix = ''): string[] =>
  typeof value === 'object' && value !== null
    ? Object.entries(value).flatMap(([k, v]) => keys(v, `${prefix}${k}.`))
    : [prefix.slice(0, -1)];

describe('admin plans i18n', () => {
  it('has a plans section in en and sk with the same keys', () => {
    const e = (en as Record<string, unknown>).plans;
    const s = (sk as Record<string, unknown>).plans;
    expect(e).toBeDefined();
    expect(s).toBeDefined();
    expect(keys(s).sort()).toEqual(keys(e).sort());
    expect((en as { nav: Record<string, string> }).nav.plans).toBeDefined();
    expect((sk as { nav: Record<string, string> }).nav.plans).toBeDefined();
  });
});
