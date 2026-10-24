import { describe, expect, it } from 'vitest';

import {
  EngineModelPinSchema,
  EngineModelResolutionSchema,
  RUNTIME_SETTINGS_EXTRA_KEYS,
  RUNTIME_SETTING_KEYS,
  SETTINGS,
  effectiveRuntimeSettings,
  effectiveTypesafeModel,
  settingDefault,
  type RuntimeEnvDefaults,
  type RuntimeSettingsContext,
  type RuntimeSettingsValues,
} from '../src/index.js';

/**
 * JEV-2 ruler (contract points 2, 3): the resolution record of `jev-latest`, the pin's alias, the
 * registered setting `engine.model_resolution` and the effective values derived from them.
 */

const PROD: RuntimeSettingsContext = {
  production: true,
  providerHostAllowlist: ['api.typesafe.ai', 'ollama.com', 'libretranslate'],
  ollamaPricedModels: ['glm-5.3-flash', 'glm-5.3'],
};
const ENV: RuntimeEnvDefaults = {
  typesafeModel: 'jev-1.13.0',
  typesafeBaseUrl: 'https://api.typesafe.ai',
  typesafePricePerMtokUsd: 0.042,
  engineConcurrency: 8,
  llmFallbackEnabled: false,
  ollamaModelFast: 'glm-5.3-flash',
  ollamaModelStrong: 'glm-5.3',
  ollamaBaseUrl: 'https://ollama.com',
  ollamaMaxConcurrency: 1,
  prefilterMinCards: 60,
  autoAnalysisDailyCap: 1000,
  ingestMaxAgeDays: 14,
  fetchTimeoutMs: 20_000,
  fetchMaxBytes: 5_242_880,
  rateLimitsEnabled: true,
  libretranslateUrl: 'http://libretranslate:5000',
};
const ENV_ALIAS: RuntimeEnvDefaults = { ...ENV, typesafeModel: 'jev-latest' };

const row = (model: string, extra: Record<string, unknown> = {}) => ({
  alias: 'jev-latest',
  model,
  resolvedAt: '2026-10-01T10:00:00.000Z',
  checkedAt: '2026-10-02T10:00:00.000Z',
  ...extra,
});

const eff = (
  rows: Record<string, unknown>,
  env: RuntimeEnvDefaults = ENV,
  ctx: RuntimeSettingsContext = PROD,
) => effectiveRuntimeSettings(new Map(Object.entries(rows)), env, ctx);

describe('JEV-2 M1 EngineModelResolutionSchema', () => {
  it('accepts a valid row, also with previous', () => {
    expect(EngineModelResolutionSchema.parse(row('jev-1.13.0'))).toEqual(row('jev-1.13.0'));
    const withPrevious = row('jev-1.14.0', {
      previous: { model: 'jev-1.13.0', until: '2026-10-02T10:00:00.000Z' },
    });
    expect(EngineModelResolutionSchema.parse(withPrevious)).toEqual(withPrevious);
    expect(EngineModelResolutionSchema.safeParse(row('jev-1.14.0-rc1')).success).toBe(true);
  });

  it('refuses a wrong alias, a model that is not a concrete Jev release, extra keys and bad dates', () => {
    const bad = (value: unknown) => EngineModelResolutionSchema.safeParse(value).success;
    expect(bad(row('jev-1.13.0', { alias: 'latest' }))).toBe(false);
    expect(bad(row('jev-1.13.0', { alias: 'Jev-Latest' }))).toBe(false);
    expect(bad(row('jev-latest'))).toBe(false);
    expect(bad(row('gpt-4-1.0.0'))).toBe(false);
    expect(bad(row('jev-fake'))).toBe(false);
    expect(bad(row('jev-beta'))).toBe(false);
    expect(bad(row('jev-1.13.0', { extra: 1 }))).toBe(false);
    expect(bad(row('jev-1.13.0', { resolvedAt: 'yesterday' }))).toBe(false);
    expect(bad(row('jev-1.13.0', { checkedAt: '2026-13-45' }))).toBe(false);
    expect(
      bad(
        row('jev-1.14.0', { previous: { model: 'jev-latest', until: '2026-10-02T10:00:00.000Z' } }),
      ),
    ).toBe(false);
    expect(bad(row('jev-1.14.0', { previous: { model: 'jev-1.13.0', until: 'soon' } }))).toBe(
      false,
    );
    expect(
      bad(
        row('jev-1.14.0', {
          previous: { model: 'jev-1.13.0', until: '2026-10-02T10:00:00.000Z', x: 1 },
        }),
      ),
    ).toBe(false);
    // control: the untouched row is fine
    expect(bad(row('jev-1.13.0'))).toBe(true);
    const { checkedAt: _omit, ...missing } = row('jev-1.13.0');
    expect(bad(missing)).toBe(false);
  });
});

describe('JEV-2 M2 EngineModelPinSchema alias', () => {
  const pin = { model: 'jev-1.13.0', since: '2026-10-01T00:00:00.000Z' };
  it('accepts alias jev-latest and refuses any other', () => {
    expect(EngineModelPinSchema.parse({ ...pin, alias: 'jev-latest' })).toEqual({
      ...pin,
      alias: 'jev-latest',
    });
    expect(EngineModelPinSchema.safeParse({ ...pin, alias: 'x' }).success).toBe(false);
    expect(EngineModelPinSchema.safeParse({ ...pin, alias: 'latest' }).success).toBe(false);
    // control: a pin without alias is still valid and parses unchanged
    expect(EngineModelPinSchema.parse(pin)).toEqual(pin);
  });
});

describe('JEV-2 M3 registry', () => {
  it('registers engine.model_resolution: worker writes, no default', () => {
    const def = SETTINGS['engine.model_resolution' as keyof typeof SETTINGS];
    expect(def).toBeDefined();
    expect(def.writers).toEqual(['worker']);
    expect(
      settingDefault('engine.model_resolution' as never, {
        dailyBudgetUsd: 2,
        languageModes: { en: 'native', sk: 'native', cs: 'native' },
        signupMode: 'invite',
      }),
    ).toBeUndefined();
    // control: another worker-written key keeps its own writers
    expect(SETTINGS['engine.model_probe'].writers).toEqual(['worker']);
    expect(SETTINGS['engine.model_pin'].writers).toEqual(['seed', 'worker']);
  });

  it('keeps the 14 runtime keys and lists the resolution as the one extra key', () => {
    expect(RUNTIME_SETTING_KEYS).toHaveLength(14);
    expect(RUNTIME_SETTING_KEYS as readonly string[]).not.toContain('engine.model_resolution');
    expect(RUNTIME_SETTINGS_EXTRA_KEYS).toEqual(['engine.model_resolution']);
  });
});

describe('JEV-2 M4 effectiveRuntimeSettings: typesafeResolvedModel', () => {
  const alias = { 'engine.typesafe_model': 'jev-latest' };

  it('alias with a valid matching row resolves to the row model; two rows give two results', () => {
    const a = eff({ ...alias, 'engine.model_resolution': row('jev-1.13.0') });
    expect(a.problems).toEqual([]);
    expect(a.values.typesafeModel).toBe('jev-latest');
    expect(a.values.typesafeResolvedModel).toBe('jev-1.13.0');
    const b = eff({ ...alias, 'engine.model_resolution': row('jev-1.14.0') });
    expect(b.values.typesafeResolvedModel).toBe('jev-1.14.0');
  });

  it('alias resolves through future fields at both object levels', () => {
    const r = eff({
      ...alias,
      'engine.model_resolution': row('jev-1.13.0', {
        extra: true,
        previous: { model: 'jev-1.12.0', until: '2026-10-01T00:00:00Z', extra: true },
      }),
    });
    expect(r.values.typesafeResolvedModel).toBe('jev-1.13.0');
    expect(r.problems).toEqual([]);
  });

  it('alias without a row is unresolved and reports no problem for the missing row', () => {
    const r = eff(alias);
    expect(r.values.typesafeModel).toBe('jev-latest');
    expect(r.values.typesafeResolvedModel).toBeNull();
    expect(r.problems.map((p) => p.key)).not.toContain('engine.model_resolution');
    expect(
      eff({ ...alias, 'engine.model_resolution': null }).values.typesafeResolvedModel,
    ).toBeNull();
  });

  it('alias with an invalid row is unresolved and the row is reported in problems', () => {
    for (const bad of [
      row('jev-latest'),
      row('gpt-4-1.0.0'),
      row('jev-1.13.0', { alias: 'x' }),
      'jev-1.13.0',
    ]) {
      const r = eff({ ...alias, 'engine.model_resolution': bad });
      expect(r.values.typesafeResolvedModel, JSON.stringify(bad)).toBeNull();
      expect(
        r.problems.map((p) => p.key),
        JSON.stringify(bad),
      ).toContain('engine.model_resolution');
    }
    // control: the same setting with a valid row has no such problem
    expect(eff({ ...alias, 'engine.model_resolution': row('jev-1.13.0') }).problems).toEqual([]);
  });

  it('a concrete configured model never has a resolved model, whatever the row says', () => {
    const concrete = eff({
      'engine.typesafe_model': 'jev-1.14.0',
      'engine.model_resolution': row('jev-1.13.0'),
    });
    expect(concrete.values.typesafeResolvedModel).toBeNull();
    expect(concrete.values.typesafeModel).toBe('jev-1.14.0');
    // env concrete + a row
    expect(
      eff({ 'engine.model_resolution': row('jev-1.13.0') }).values.typesafeResolvedModel,
    ).toBeNull();
    // control: flipping only the configured value to the alias resolves
    expect(
      eff({ 'engine.typesafe_model': 'jev-latest', 'engine.model_resolution': row('jev-1.13.0') })
        .values.typesafeResolvedModel,
    ).toBe('jev-1.13.0');
  });

  it('a stored null model with an env alias behaves as the alias', () => {
    const withRow = eff(
      { 'engine.typesafe_model': null, 'engine.model_resolution': row('jev-1.15.0') },
      ENV_ALIAS,
    );
    expect(withRow.values.typesafeModel).toBe('jev-latest');
    expect(withRow.values.typesafeResolvedModel).toBe('jev-1.15.0');
    expect(
      eff({ 'engine.typesafe_model': null }, ENV_ALIAS).values.typesafeResolvedModel,
    ).toBeNull();
    // control: a stored concrete model overrides the env alias
    const overridden = eff(
      { 'engine.typesafe_model': 'jev-1.14.0', 'engine.model_resolution': row('jev-1.15.0') },
      ENV_ALIAS,
    );
    expect(overridden.values.typesafeResolvedModel).toBeNull();
  });

  it('works outside production too', () => {
    const dev = eff(
      { 'engine.typesafe_model': 'jev-latest', 'engine.model_resolution': row('jev-1.13.0') },
      ENV,
      { ...PROD, production: false },
    );
    expect(dev.values.typesafeResolvedModel).toBe('jev-1.13.0');
  });
});

describe('JEV-2 M5 effectiveTypesafeModel', () => {
  const values = (over: Partial<RuntimeSettingsValues>): RuntimeSettingsValues => ({
    ...eff({}).values,
    ...over,
  });
  it('returns the configured model, the resolved id of an alias, or null', () => {
    expect(
      effectiveTypesafeModel(values({ typesafeModel: 'jev-1.13.0', typesafeResolvedModel: null })),
    ).toBe('jev-1.13.0');
    expect(
      effectiveTypesafeModel(
        values({ typesafeModel: 'jev-latest', typesafeResolvedModel: 'jev-1.14.0' }),
      ),
    ).toBe('jev-1.14.0');
    expect(
      effectiveTypesafeModel(values({ typesafeModel: 'jev-latest', typesafeResolvedModel: null })),
    ).toBeNull();
    // controls: another resolved id gives another result; a concrete model ignores a stray resolved id
    expect(
      effectiveTypesafeModel(
        values({ typesafeModel: 'jev-latest', typesafeResolvedModel: 'jev-1.15.0' }),
      ),
    ).toBe('jev-1.15.0');
    expect(
      effectiveTypesafeModel(
        values({ typesafeModel: 'jev-1.13.0', typesafeResolvedModel: 'jev-9.9.9' }),
      ),
    ).toBe('jev-1.13.0');
  });
});

describe('JEV-2 M6 the values always carry typesafeResolvedModel', () => {
  it('has the key (null) for a concrete setting, absent rows and invalid rows', () => {
    for (const rows of [
      {},
      { 'engine.typesafe_model': 'jev-latest' },
      { 'engine.typesafe_model': 'jev-latest', 'engine.model_resolution': 7 },
      { 'engine.typesafe_model': 'jev-1.14.0' },
    ]) {
      const { values } = eff(rows);
      expect('typesafeResolvedModel' in values, JSON.stringify(rows)).toBe(true);
      expect(values.typesafeResolvedModel).toBeNull();
    }
  });
});
