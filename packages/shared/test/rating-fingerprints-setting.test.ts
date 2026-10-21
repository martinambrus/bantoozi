import { describe, expect, it } from 'vitest';

import {
  ADMIN_PATCHABLE_SETTING_KEYS,
  RATING_FINGERPRINTS_KEY,
  RATING_FINGERPRINTS_MAX,
  RatingFingerprintEntrySchema,
  RatingFingerprintsSchema,
  SETTINGS,
  settingDefault,
} from '../src/index.js';

const sha = (c: string): string => c.repeat(64);
const entry = {
  family: sha('f'),
  settings: { 'engine.model_pin': { model: 'jev-1.13.0' }, language_modes: { sk: 'native' } },
  firstSeenAt: '2026-10-21T10:00:00.000Z',
};

const registry = (n: number): Record<string, typeof entry> =>
  Object.fromEntries(
    Array.from({ length: n }, (_, i) => [i.toString(16).padStart(64, '0'), entry]),
  );

describe('JEV-4 engine.rating_fingerprints setting', () => {
  it('R1 constants', () => {
    expect(RATING_FINGERPRINTS_KEY).toBe('engine.rating_fingerprints');
    expect(RATING_FINGERPRINTS_MAX).toBe(64);
  });

  it('R2 entry schema accepts a valid entry (also with an offset time)', () => {
    expect(RatingFingerprintEntrySchema.parse(entry)).toEqual(entry);
    const offset = { ...entry, firstSeenAt: '2026-10-21T12:00:00+02:00' };
    expect(RatingFingerprintEntrySchema.safeParse(offset).success).toBe(true);
  });

  it.each([
    ['extra key', { ...entry, extra: 1 }],
    ['family not a sha', { ...entry, family: 'abc' }],
    ['family uppercase hex length 63', { ...entry, family: sha('f').slice(1) }],
    ['family not hex', { ...entry, family: sha('g') }],
    ['settings not JSON', { ...entry, settings: { x: () => 1 } }],
    ['settings an array', { ...entry, settings: [] }],
    ['settings missing', { family: entry.family, firstSeenAt: entry.firstSeenAt }],
    ['bad date', { ...entry, firstSeenAt: 'yesterday' }],
    ['impossible date', { ...entry, firstSeenAt: '2026-13-45T00:00:00Z' }],
    ['date missing', { family: entry.family, settings: entry.settings }],
  ])('R3 entry schema rejects %s', (_name, value) => {
    expect(RatingFingerprintEntrySchema.safeParse(value).success).toBe(false);
  });

  it('R4 record schema keys must be 64-hex shas', () => {
    expect(RatingFingerprintsSchema.safeParse({ [sha('a')]: entry }).success).toBe(true);
    expect(RatingFingerprintsSchema.safeParse({ nope: entry }).success).toBe(false);
    expect(RatingFingerprintsSchema.safeParse({ [sha('a')]: { ...entry, extra: 1 } }).success).toBe(
      false,
    );
  });

  it('R5 empty, 64-entry and 200-entry records parse (the reader has no cap)', () => {
    expect(RatingFingerprintsSchema.safeParse({}).success).toBe(true);
    expect(RatingFingerprintsSchema.safeParse(registry(64)).success).toBe(true);
    const big = registry(200);
    expect(Object.keys(big)).toHaveLength(200);
    expect(RatingFingerprintsSchema.safeParse(big).success).toBe(true);
  });

  it('R6 registered in SETTINGS: worker is the only writer, default {}', () => {
    const def = SETTINGS['engine.rating_fingerprints' as keyof typeof SETTINGS];
    expect(def).toBeDefined();
    expect(def.writers).toEqual(['worker']);
    expect(
      settingDefault('engine.rating_fingerprints' as never, {
        dailyBudgetUsd: 2,
        languageModes: { en: 'native', sk: 'native', cs: 'native' },
        signupMode: 'invite',
      }),
    ).toEqual({});
    expect(SETTINGS['engine.model_probe'].writers).toEqual(['worker']);
  });

  it('R7 the key is not admin-patchable (control: an admin key is)', () => {
    expect(ADMIN_PATCHABLE_SETTING_KEYS as readonly string[]).not.toContain(
      'engine.rating_fingerprints',
    );
    expect(ADMIN_PATCHABLE_SETTING_KEYS as readonly string[]).toContain('language_modes');
  });
});
