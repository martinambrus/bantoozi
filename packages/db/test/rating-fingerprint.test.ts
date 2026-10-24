import { describe, expect, it } from 'vitest';

import {
  effectiveRatingSettings,
  RATING_FINGERPRINT_STATE_KEYS,
  ratingFingerprintOf,
  ratingFingerprintStateOf,
  readRatingFingerprint,
  type RatingDefaults,
} from '../src/index.js';

/**
 * JEV-4 T1 ruler: the exact rating sha never changes meaning (golden vectors from before the change),
 * the family sha ignores the release inside one Jev major, and the state reader folds the registry.
 */

const defaults: RatingDefaults = {
  model: 'jev-1.13.0',
  languageModes: { sk: 'translate' },
  cardTextMode: 'as_written',
};
const fakeExecutor = (rows: Record<string, unknown>) =>
  ({
    execute: async () => ({ rows: Object.entries(rows).map(([key, value]) => ({ key, value })) }),
  }) as never;
const stored = (rows: Record<string, unknown>): ReadonlyMap<string, unknown> =>
  new Map(Object.entries(rows));
const pin = (model: string, extra: Record<string, unknown> = {}) => ({
  'engine.model_pin': { model, since: '2026-10-21T00:00:00.000Z', ...extra },
});
const SETS = { enrich: 'e1', match: 'm1', cluster: 'c1' };
const MODES = {
  'question_sets.active': SETS,
  language_modes: { sk: 'native', cs: 'translate' },
  card_text_mode: 'english',
};

const GOLDEN: [string, Record<string, unknown>, string][] = [
  [
    'nothing stored, env defaults 1.13.0',
    {},
    'f09590d1040bf06ba755536635302fd6d517619a36d702850841c6822b84052d',
  ],
  [
    'pin 1.13.0',
    pin('jev-1.13.0'),
    'f09590d1040bf06ba755536635302fd6d517619a36d702850841c6822b84052d',
  ],
  [
    'pin 1.14.0',
    pin('jev-1.14.0'),
    '20a51ded9b6b452b7d5c214bf9979064966677e532576d3bf64b8d8e7438c876',
  ],
  [
    'pin 1.14.0 with alias field',
    pin('jev-1.14.0', { alias: 'jev-latest' }),
    '20a51ded9b6b452b7d5c214bf9979064966677e532576d3bf64b8d8e7438c876',
  ],
  [
    'pin 2.0.0',
    pin('jev-2.0.0'),
    '23b46f53594ae40a786567d5b7120163cf2f45774b15c8c651636196fe3cf3a2',
  ],
  [
    'pin jev-latest (alias literal)',
    pin('jev-latest'),
    'e45669f3841db4808cab5dbffd16d036eb23b9da1d7d245d4b5886e7cefda4e1',
  ],
  [
    'pin 1.13.0 + laya',
    pin('jev-1.13.0', { laya: { checkpointSha: 'a'.repeat(64), calibrationVersion: 'v1' } }),
    'ecb88ca0ecd45bcecb41461fdc88d803165c89fb64647d0f6d856da0160d7090',
  ],
  [
    'pin 1.13.0 + question sets + modes',
    { ...pin('jev-1.13.0'), ...MODES },
    'de1c5f0d93e5a8e5749e20b4d3ca8165f44741a307168c43754727478495d3e6',
  ],
  [
    'pin 1.14.0 + question sets + modes',
    { ...pin('jev-1.14.0'), ...MODES },
    '5499f97dc25f6ad287d7b68161892ae3edc825a6f061d523cd17aaee251c1887',
  ],
];

const fp = (rows: Record<string, unknown>, d: RatingDefaults = defaults) =>
  ratingFingerprintOf(stored(rows), d);
const registryEntry = (family: string, firstSeenAt = '2026-10-01T00:00:00.000Z') => ({
  family,
  settings: { language_modes: { sk: 'native' } },
  firstSeenAt,
});
const REGISTRY_KEY = 'engine.rating_fingerprints';

describe('JEV-4 exact sha golden vectors', () => {
  it.each(GOLDEN)('G1 readRatingFingerprint reproduces %s', async (_name, rows, expected) => {
    await expect(readRatingFingerprint(fakeExecutor(rows), defaults)).resolves.toBe(expected);
  });

  it.each(GOLDEN)(
    'G2 ratingFingerprintOf(...).sha equals the exact sha of %s',
    (_name, rows, expected) => {
      expect(fp(rows).sha).toBe(expected);
    },
  );
});

describe('JEV-4 family sha', () => {
  it('F1 equal across releases of one major (1.13.0, 1.14.0, 1.14.0-rc1)', () => {
    const a = fp({ ...pin('jev-1.13.0'), ...MODES });
    const b = fp({ ...pin('jev-1.14.0'), ...MODES });
    const c = fp({ ...pin('jev-1.14.0-rc1'), ...MODES });
    expect(a.familySha).toMatch(/^[0-9a-f]{64}$/);
    expect(b.familySha).toBe(a.familySha);
    expect(c.familySha).toBe(a.familySha);
    expect(new Set([a.sha, b.sha, c.sha]).size).toBe(3);
  });

  it('F2 two 2.x releases are equal and differ from every 1.x', () => {
    const one = fp(pin('jev-1.13.0'));
    const two = fp(pin('jev-2.0.0'));
    expect(fp(pin('jev-2.7.1')).familySha).toBe(two.familySha);
    expect(two.familySha).not.toBe(one.familySha);
  });

  it('F3 the alias jev-latest is its own family', () => {
    expect(fp(pin('jev-latest')).familySha).not.toBe(fp(pin('jev-1.13.0')).familySha);
    expect(fp(pin('jev-latest')).familySha).toBe(
      fp(pin('jev-latest', { alias: 'jev-latest' })).familySha,
    );
  });

  it('F4 sensitive to language modes, card text mode, active question sets and laya', () => {
    const base = fp(pin('jev-1.13.0')).familySha;
    const variants = [
      fp({ ...pin('jev-1.13.0'), language_modes: { sk: 'native' } }),
      fp({ ...pin('jev-1.13.0'), card_text_mode: 'english' }),
      fp({ ...pin('jev-1.13.0'), 'question_sets.active': SETS }),
      fp(pin('jev-1.13.0', { laya: { checkpointSha: 'a'.repeat(64), calibrationVersion: 'v1' } })),
      fp(pin('jev-1.13.0'), { ...defaults, languageModes: { sk: 'native' } }),
      fp(pin('jev-1.13.0'), { ...defaults, cardTextMode: 'english' }),
    ].map((f) => f.familySha);
    for (const v of variants) expect(v).not.toBe(base);
    expect(new Set(variants.slice(0, 4)).size).toBe(4);
    expect(variants[4]).toBe(variants[0]);
    expect(variants[5]).toBe(variants[1]);
  });

  it('F5 equal when only the pin alias, since or llm differ', () => {
    const base = fp(pin('jev-1.13.0'));
    const other = fp({
      'engine.model_pin': {
        model: 'jev-1.13.0',
        alias: 'jev-latest',
        since: '2030-01-01T00:00:00.000Z',
        llm: { provider: 'x', model: 'y' },
      },
    });
    expect(other.familySha).toBe(base.familySha);
    expect(other.sha).toBe(base.sha);
  });

  it('F6 the family sha is never equal to an exact sha, and an env default behaves like a pin', () => {
    for (const [, rows] of GOLDEN) {
      const f = fp(rows);
      expect(f.familySha).not.toBe(f.sha);
    }
    expect(fp({}).familySha).toBe(fp(pin('jev-1.13.0')).familySha);
    expect(fp({}, { ...defaults, model: 'jev-1.14.0' }).familySha).toBe(fp({}).familySha);
  });

  it('F7 the settings of the fingerprint are the effective settings with the exact model', () => {
    const rows = { ...pin('jev-1.14.0'), ...MODES };
    const f = fp(rows);
    expect(f.settings).toEqual(effectiveRatingSettings(stored(rows), defaults));
    expect(f.settings['engine.model_pin']).toEqual({ model: 'jev-1.14.0' });
  });

  it('F8 a foreign model id is its own family (control: not collapsed by version)', () => {
    expect(fp(pin('foo-1.2.3')).familySha).not.toBe(fp(pin('foo-1.3.0')).familySha);
    expect(fp(pin('foo-1.2.3')).familySha).not.toBe(fp(pin('jev-1.2.3')).familySha);
  });
});

describe('JEV-4 ratingFingerprintStateOf', () => {
  const other = 'b'.repeat(64);
  const fam = 'c'.repeat(64);

  it('S1 families holds valid registry entries and the current sha mapped to its family', () => {
    const rows = pin('jev-1.14.0');
    const cur = fp(rows);
    const state = ratingFingerprintStateOf(
      stored({ ...rows, [REGISTRY_KEY]: { [other]: registryEntry(fam) } }),
      defaults,
    );
    expect(state.sha).toBe(cur.sha);
    expect(state.familySha).toBe(cur.familySha);
    expect(state.families).toEqual({ [other]: fam, [cur.sha]: cur.familySha });
    expect(state.registered).toBe(false);
  });

  it('S2 registered is true iff the registry lists the current exact sha', () => {
    const rows = pin('jev-1.14.0');
    const cur = fp(rows);
    const listed = ratingFingerprintStateOf(
      stored({ ...rows, [REGISTRY_KEY]: { [cur.sha]: registryEntry(cur.familySha) } }),
      defaults,
    );
    expect(listed.registered).toBe(true);
    expect(listed.families).toEqual({ [cur.sha]: cur.familySha });
    expect(ratingFingerprintStateOf(stored(rows), defaults).registered).toBe(false);
    const unrelated = ratingFingerprintStateOf(
      stored({ ...rows, [REGISTRY_KEY]: { [other]: registryEntry(fam) } }),
      defaults,
    );
    expect(unrelated.registered).toBe(false);
  });

  it('S3 ignores corrupt known fields and keeps entries carrying future fields', () => {
    const rows = pin('jev-1.14.0');
    const cur = fp(rows);
    const state = ratingFingerprintStateOf(
      stored({
        ...rows,
        [REGISTRY_KEY]: {
          [other]: { ...registryEntry(fam), extra: true },
          ['d'.repeat(64)]: {
            family: 'not-a-sha',
            settings: {},
            firstSeenAt: '2026-10-01T00:00:00.000Z',
          },
          ['e'.repeat(64)]: 'junk',
          ['f'.repeat(64)]: registryEntry(fam),
          'short-key': registryEntry(fam),
        },
      }),
      defaults,
    );
    expect(state.families).toEqual({
      [other]: fam,
      ['f'.repeat(64)]: fam,
      [cur.sha]: cur.familySha,
    });
  });

  it.each([
    ['a string', 'junk'],
    ['an array', [registryEntry(fam)]],
    ['null', null],
    ['a number', 3],
    ['absent', undefined],
  ])('S4 a registry that is %s reads as empty and never throws', (_name, value) => {
    const rows: Record<string, unknown> = pin('jev-1.14.0');
    if (value !== undefined) rows[REGISTRY_KEY] = value;
    const cur = fp(rows);
    const state = ratingFingerprintStateOf(stored(rows), defaults);
    expect(state.families).toEqual({ [cur.sha]: cur.familySha });
    expect(state.registered).toBe(false);
  });

  it('S5 the settings of the state equal the effective settings; the current sha wins over a stale registry family', () => {
    const rows = { ...pin('jev-1.14.0'), ...MODES };
    const cur = fp(rows);
    const state = ratingFingerprintStateOf(
      stored({ ...rows, [REGISTRY_KEY]: { [cur.sha]: registryEntry(fam) } }),
      defaults,
    );
    expect(state.settings).toEqual(effectiveRatingSettings(stored(rows), defaults));
    expect(state.families[cur.sha]).toBe(cur.familySha);
  });

  it('S6 prototype-named registry keys are not entries', () => {
    const rows = pin('jev-1.14.0');
    const cur = fp(rows);
    const state = ratingFingerprintStateOf(
      stored({
        ...rows,
        [REGISTRY_KEY]: JSON.parse(`{"__proto__": ${JSON.stringify(registryEntry(fam))}}`),
      }),
      defaults,
    );
    expect(Object.keys(state.families)).toEqual([cur.sha]);
  });
});

describe('JEV-4 RATING_FINGERPRINT_STATE_KEYS', () => {
  it('K1 is the four fingerprint keys plus the registry key', () => {
    expect([...RATING_FINGERPRINT_STATE_KEYS].sort()).toEqual(
      [
        'engine.model_pin',
        'question_sets.active',
        'language_modes',
        'card_text_mode',
        REGISTRY_KEY,
      ].sort(),
    );
  });
});

it('ignores future fields in active sets and nested laya when hashing effective settings', () => {
  const laya = { checkpointSha: 'a'.repeat(64), calibrationVersion: 'v1' };
  const rows = {
    ...pin('jev-1.13.0', { laya }),
    'question_sets.active': { enrich: '1', match: '2' },
  };
  const future = {
    ...pin('jev-1.13.0', { laya: { ...laya, future: 1 }, future: 2 }),
    'question_sets.active': { enrich: '1', match: '2', future: '3' },
  };
  expect(fp(future)).toEqual(fp(rows));
});
