import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RANKER_CONFIG,
  RANKER_VERSION,
  RankerSettingsError,
  resolveRankerSettings,
} from '../src/index.js';

describe('resolveRankerSettings (spec 06 §7, §11)', () => {
  it('uses the shared defaults and settings version 0 when neither row exists', () => {
    const settings = resolveRankerSettings({ thresholds: undefined, settingsVersion: undefined });
    expect(settings.config).toEqual(DEFAULT_RANKER_CONFIG);
    expect(settings.settingsVersion).toBe('0');
    expect(settings.scoreVersion).toBe(`${RANKER_VERSION}:0`);
  });

  it('merges a valid override and composes the score version from the stored version', () => {
    const settings = resolveRankerSettings({
      thresholds: { lanes: { forYou: 0.7 }, tiers: [0.2, 0.4, 0.6, 0.8] },
      settingsVersion: 12,
    });
    expect(settings.config.lanes).toEqual({ forYou: 0.7, maybe: 0.35 });
    expect(settings.config.tiers).toEqual([0.2, 0.4, 0.6, 0.8]);
    expect(settings.config.never).toEqual(DEFAULT_RANKER_CONFIG.never);
    expect(settings.settingsVersion).toBe('12');
    expect(settings.scoreVersion).toBe(`${RANKER_VERSION}:12`);
  });

  it('rejects an override containing windowDays: the window is the fixed RANK_WINDOW_DAYS', () => {
    expect(() =>
      resolveRankerSettings({ thresholds: { windowDays: 30 }, settingsVersion: 1 }),
    ).toThrow(RankerSettingsError);
    expect(() =>
      resolveRankerSettings({ thresholds: { model: { windowDays: 30 } }, settingsVersion: 1 }),
    ).toThrow(RankerSettingsError);
  });

  it.each([
    ['a JSON null', null],
    ['a string', 'lanes'],
    ['an array', []],
    ['an unknown key', { thresholds: {} }],
    ['an out-of-range probability', { lanes: { forYou: 1.5 } }],
    ['a nonfinite number', { mustFloor: Number.NaN }],
    ['inverted lanes', { lanes: { maybe: 0.7, forYou: 0.6 } }],
    ['inverted never bands', { never: { soft: 0.8, hide: 0.7 } }],
    ['three tiers', { tiers: [0.25, 0.45, 0.65] }],
    ['a decreasing lambda grid', { model: { lambdaGrid: [3, 1] } }],
  ])('fails visibly on a malformed stored override (%s)', (_name, thresholds) => {
    let error: unknown;
    try {
      resolveRankerSettings({ thresholds, settingsVersion: 3 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RankerSettingsError);
    expect(error).toMatchObject({ code: 'INTERNAL', details: { key: 'ranker.thresholds' } });
  });

  it.each([
    ['a negative number', -1],
    ['a fraction', 1.5],
    ['a string', '3'],
    ['null', null],
    ['an unsafe integer', 2 ** 60],
  ])('fails visibly on a malformed stored settings version (%s)', (_name, settingsVersion) => {
    expect(() => resolveRankerSettings({ thresholds: {}, settingsVersion })).toThrow(
      expect.objectContaining({ details: { key: 'ranker.settings_version' } }),
    );
  });

  it('keeps score versions collision-free across settings versions', () => {
    const keys = [0, 1, 10, 11, 100, 10_000].map(
      (settingsVersion) =>
        resolveRankerSettings({ thresholds: undefined, settingsVersion }).scoreVersion,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});
