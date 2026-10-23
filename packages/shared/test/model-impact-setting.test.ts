import { describe, expect, it } from 'vitest';

import {
  ADMIN_PATCHABLE_SETTING_KEYS,
  AdminEngineModelSchema,
  EngineModelImpactSchema,
  ModelProbeBodySchema,
  ModelProbeFailedDetailsSchema,
  ModelProbeRequiredDetailsSchema,
  SETTINGS,
  settingDefault,
} from '../src/index.js';

/**
 * JEV-5 registration points: the worker-published `engine.model_impact` setting (how many personal
 * models a family change would restart) and the DTOs of the admin model routes.
 */

const AT = '2026-10-23T10:00:00.000Z';
const ENV = {
  dailyBudgetUsd: 2,
  languageModes: { en: 'native', sk: 'native', cs: 'native' },
  signupMode: 'invite',
} as const;

describe('engine.model_impact setting', () => {
  it('is worker-written, has no default and is not admin-patchable', () => {
    expect(SETTINGS['engine.model_impact'].writers).toEqual(['worker']);
    expect(settingDefault('engine.model_impact', ENV)).toBeUndefined();
    expect(
      (ADMIN_PATCHABLE_SETTING_KEYS as readonly string[]).includes('engine.model_impact'),
    ).toBe(false);
  });

  it('accepts a time and a count and nothing else', () => {
    expect(EngineModelImpactSchema.parse({ at: AT, activeModels: 0 })).toEqual({
      at: AT,
      activeModels: 0,
    });
    expect(EngineModelImpactSchema.parse({ at: AT, activeModels: 4167 })).toEqual({
      at: AT,
      activeModels: 4167,
    });
    for (const bad of [
      { at: AT, activeModels: -1 },
      { at: AT, activeModels: 1.5 },
      { at: 'yesterday', activeModels: 1 },
      { at: AT },
      { activeModels: 1 },
      { at: AT, activeModels: 1, extra: true },
    ]) {
      expect(EngineModelImpactSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('admin model DTOs', () => {
  const status = {
    now: AT,
    setting: { value: 'jev-latest', source: 'stored' },
    resolution: {
      alias: 'jev-latest',
      model: 'jev-1.13.0',
      resolvedAt: AT,
      checkedAt: AT,
    },
    pin: { model: 'jev-1.13.0', alias: 'jev-latest', since: AT },
    watch: { lastCheck: { at: AT, ok: false, error: 'provider_unavailable' } },
    probes: { 'jev-latest': { requested: 'jev-latest', answered: 'jev-1.13.0', ok: true, at: AT } },
    impact: { at: AT, activeModels: 3 },
  };

  it('describes the model status with the API clock, the resolution and the newest probes', () => {
    expect(AdminEngineModelSchema.parse(status)).toEqual(status);
    const bare = {
      now: AT,
      setting: { value: 'jev-1.13.0', source: 'env' },
      resolution: null,
      pin: null,
      watch: { lastCheck: null },
      probes: {},
      impact: null,
    };
    expect(AdminEngineModelSchema.parse(bare)).toEqual(bare);
  });

  it('is strict: a raw pin (llm, laya), an unknown field or a missing clock is refused', () => {
    expect(
      AdminEngineModelSchema.safeParse({ ...status, pin: { ...status.pin, llm: null } }).success,
    ).toBe(false);
    expect(AdminEngineModelSchema.safeParse({ ...status, extra: 1 }).success).toBe(false);
    const { now: _now, ...withoutNow } = status;
    expect(AdminEngineModelSchema.safeParse(withoutNow).success).toBe(false);
  });

  it('asks for a probe of a model id the probe job accepts', () => {
    expect(ModelProbeBodySchema.parse({ model: 'jev-1.14.0' })).toEqual({ model: 'jev-1.14.0' });
    expect(ModelProbeBodySchema.parse({ model: 'jev-latest' })).toEqual({ model: 'jev-latest' });
    for (const bad of [
      {},
      { model: '' },
      { model: 'a'.repeat(65) },
      { model: 'jev/1' },
      { model: 'x', extra: 1 },
    ]) {
      expect(ModelProbeBodySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('describes the two refusals of a save without a confirming probe', () => {
    expect(
      ModelProbeRequiredDetailsSchema.parse({
        reason: 'model_probe_required',
        model: 'jev-1.14.0',
      }),
    ).toEqual({ reason: 'model_probe_required', model: 'jev-1.14.0' });
    const failed = {
      reason: 'model_probe_failed',
      model: 'jev-1.14.0',
      answered: 'jev-1.13.0',
      error: 'model_mismatch',
      at: AT,
    };
    expect(ModelProbeFailedDetailsSchema.parse(failed)).toEqual(failed);
    const { answered: _answered, ...unanswered } = failed;
    expect(ModelProbeFailedDetailsSchema.parse(unanswered)).toEqual(unanswered);
    expect(ModelProbeFailedDetailsSchema.safeParse({ ...failed, reason: 'other' }).success).toBe(
      false,
    );
  });
});
