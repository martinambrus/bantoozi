import { describe, expect, it } from 'vitest';

import {
  ADMIN_SETTING_KEYS,
  DEFAULT_RANKER_CONFIG,
  RANK_WINDOW_DAYS,
  RankerConfigSchema,
  SEEDED_SETTING_KEYS,
  SETTINGS,
  isKnownSettingKey,
  mergeRankerConfig,
  metricsDailyKey,
  parseSetting,
  readSetting,
  settingDefault,
  settingSchema,
  type SettingEnvDefaults,
  type SettingKey,
} from '../src/index.js';

const env: SettingEnvDefaults = {
  dailyBudgetUsd: 2,
  languageModes: { en: 'native', sk: 'native', cs: 'native' },
  signupMode: 'invite',
};

/** The key registry of spec 02 §2 (static keys; `metrics.daily.<date>` is tested separately). */
const SPEC_KEYS = [
  'engine.daily_budget_usd',
  'engine.llm_daily_cap',
  'engine.prefilter_enabled',
  'engine.circuit',
  'engine.budget_alerts',
  'engine.laya',
  'engine.model_pin',
  'language_modes',
  'card_text_mode',
  'translate.tier2_daily_cap',
  'ranker.thresholds',
  'ranker.settings_version',
  'question_sets.active',
  'signup_mode',
  'ops.events',
  'house.progress',
  'alerts.state',
  'worker.heartbeat',
];

describe('settings registry (spec 02 §2)', () => {
  it('has a zod schema for every key of the spec', () => {
    expect(Object.keys(SETTINGS).sort()).toEqual([...SPEC_KEYS].sort());
    expect(isKnownSettingKey('metrics.daily.2026-09-25')).toBe(true);
    expect(isKnownSettingKey('metrics.daily.yesterday')).toBe(false);
    expect(() => settingSchema('nope')).toThrow();
  });

  it('uses the defaults of the spec when the row is missing', () => {
    expect(settingDefault('engine.daily_budget_usd', { ...env, dailyBudgetUsd: 3.5 })).toBe(3.5);
    expect(settingDefault('engine.llm_daily_cap', env)).toBe(200);
    expect(settingDefault('engine.prefilter_enabled', env)).toBe(false);
    expect(settingDefault('engine.circuit', env)).toEqual({
      typesafe: { state: 'closed', reopenCount: 0 },
      llm: { state: 'closed', reopenCount: 0 },
      resetRequested: {},
    });
    expect(settingDefault('engine.budget_alerts', env)).toBeUndefined();
    expect(settingDefault('engine.laya', env)).toEqual({});
    expect(settingDefault('engine.model_pin', env)).toBeUndefined();
    expect(settingDefault('language_modes', env)).toEqual(env.languageModes);
    expect(settingDefault('card_text_mode', env)).toBe('as_written');
    expect(settingDefault('translate.tier2_daily_cap', env)).toBe(300);
    expect(settingDefault('ranker.thresholds', env)).toEqual({});
    expect(settingDefault('ranker.settings_version', env)).toBe(0);
    expect(settingDefault('question_sets.active', env)).toEqual({});
    expect(settingDefault('signup_mode', { ...env, signupMode: 'closed' })).toBe('closed');
    expect(settingDefault('ops.events', env)).toEqual([]);
    expect(settingDefault('house.progress', env)).toEqual({});
    expect(settingDefault('alerts.state', env)).toEqual({});
    expect(settingDefault('worker.heartbeat', env)).toEqual({});
  });

  it('defaults are valid values of their own schemas', () => {
    for (const key of Object.keys(SETTINGS) as SettingKey[]) {
      const value = settingDefault(key, env);
      if (value !== undefined) expect(() => parseSetting(key, value)).not.toThrow();
    }
  });

  it('stored rows win over env defaults', () => {
    expect(readSetting('signup_mode', 'open', env)).toBe('open');
    expect(readSetting('signup_mode', undefined, env)).toBe('invite');
  });

  it('rejects unknown keys, non-finite numbers and invalid values on write', () => {
    expect(() => parseSetting('engine.laya', { enrich: ['sk'], extra: true })).toThrow();
    expect(() => parseSetting('engine.daily_budget_usd', Number.NaN)).toThrow();
    expect(() => parseSetting('engine.daily_budget_usd', -1)).toThrow();
    expect(() => parseSetting('language_modes', { en: 'auto' })).toThrow();
    expect(() => parseSetting('language_modes', { english: 'native' })).toThrow();
    expect(() => parseSetting('question_sets.active', { enrich: 12 })).toThrow();
    expect(parseSetting('question_sets.active', { enrich: '12' })).toEqual({ enrich: '12' });
    expect(() =>
      parseSetting('house.progress', {
        'house.unknown': { updatedAt: '2026-01-01T00:00:00Z', version: 1 },
      }),
    ).toThrow();
    expect(() =>
      parseSetting('worker.heartbeat', {
        w1: {
          at: '2026-01-01T00:00:00Z',
          queues: ['feed.fetch'],
          evalIngestOnly: false,
          envCredentials: ['typesafe'],
          key: 'x',
        },
      }),
    ).toThrow();
    expect(() =>
      parseSetting(
        'ops.events',
        Array.from({ length: 51 }, () => ({ kind: 'k', detail: '', at: '2026-01-01T00:00:00Z' })),
      ),
    ).toThrow();
    expect(() =>
      settingSchema(metricsDailyKey('2026-09-25')).parse({ likeRate: Number.POSITIVE_INFINITY }),
    ).toThrow();
    expect(settingSchema(metricsDailyKey('2026-09-25')).parse({ likeRate: 0.5 })).toEqual({
      likeRate: 0.5,
    });
  });

  it('marks the admin-writable keys and the seeded keys', () => {
    expect([...ADMIN_SETTING_KEYS].sort()).toEqual(
      [
        'engine.daily_budget_usd',
        'engine.llm_daily_cap',
        'engine.prefilter_enabled',
        'engine.circuit',
        'engine.laya',
        'language_modes',
        'card_text_mode',
        'translate.tier2_daily_cap',
        'ranker.thresholds',
        'question_sets.active',
        'signup_mode',
      ].sort(),
    );
    expect([...SEEDED_SETTING_KEYS].sort()).toEqual([
      'card_text_mode',
      'language_modes',
      'question_sets.active',
    ]);
  });
});

describe('RankerConfig (spec 06 §11)', () => {
  it('validates the defaults and the fixed window', () => {
    expect(RankerConfigSchema.parse(DEFAULT_RANKER_CONFIG)).toEqual(DEFAULT_RANKER_CONFIG);
    expect(RANK_WINDOW_DAYS).toBe(14);
    expect(settingDefault('ranker.thresholds', env)).toEqual({});
  });

  it('merges a deep partial and validates the result', () => {
    const merged = mergeRankerConfig({ lanes: { forYou: 0.7 }, tiers: [0.2, 0.4, 0.6, 0.8] });
    expect(merged.lanes).toEqual({ forYou: 0.7, maybe: 0.35 });
    expect(merged.tiers).toEqual([0.2, 0.4, 0.6, 0.8]);
    expect(merged.model.minExplicit).toBe(30);
    expect(mergeRankerConfig({})).toEqual(DEFAULT_RANKER_CONFIG);
  });

  it('rejects invalid overrides atomically, including unknown keys such as windowDays', () => {
    expect(() => mergeRankerConfig({ windowDays: 30 })).toThrow();
    expect(() => mergeRankerConfig({ lanes: { maybe: 0.7 } })).toThrow();
    expect(() => mergeRankerConfig({ never: { soft: 0.8 } })).toThrow();
    expect(() => mergeRankerConfig({ tiers: [0.3, 0.2, 0.6, 0.8] })).toThrow();
    expect(() => mergeRankerConfig({ tiers: [0.2, 0.4, 0.6] })).toThrow();
    expect(() => mergeRankerConfig({ mustFloor: 1.5 })).toThrow();
    expect(() => mergeRankerConfig({ model: { keepVersions: 0 } })).toThrow();
    expect(() => mergeRankerConfig({ bm25: { k1: 0 } })).toThrow();
    expect(() => mergeRankerConfig({ demotion: { factor: Number.NaN } })).toThrow();
  });

  it('replaces model.lambdaGrid whole and validates the personal-model keys', () => {
    const merged = mergeRankerConfig({ model: { lambdaGrid: [2, 20] } });
    expect(merged.model.lambdaGrid).toEqual([2, 20]);
    expect(merged.model.cardMatchP).toBe(0.5);
    expect(merged.model.cardMinMatched).toBe(8);
    expect(() => mergeRankerConfig({ model: { lambda: 1 } })).toThrow();
    expect(() => mergeRankerConfig({ model: { lambdaGrid: [] } })).toThrow();
    expect(() => mergeRankerConfig({ model: { lambdaGrid: [3, 1] } })).toThrow();
    expect(() => mergeRankerConfig({ model: { lambdaGrid: [1, 1] } })).toThrow();
    expect(() => mergeRankerConfig({ model: { lambdaGrid: [0, 1] } })).toThrow();
    expect(() =>
      mergeRankerConfig({ model: { lambdaGrid: Array.from({ length: 11 }, (_, i) => i + 1) } }),
    ).toThrow();
    expect(() => mergeRankerConfig({ model: { cardMatchP: 0 } })).toThrow();
    expect(() => mergeRankerConfig({ model: { cardMatchP: 1.2 } })).toThrow();
    expect(() => mergeRankerConfig({ model: { cardMinMatched: 0 } })).toThrow();
  });
});
