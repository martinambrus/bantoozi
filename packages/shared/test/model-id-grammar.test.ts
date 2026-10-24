import { describe, expect, it } from 'vitest';

import {
  EngineModelProbeSchema,
  MODEL_ID_PATTERN,
  isConcreteJevModel,
  isModelAlias,
  isPinnedModel,
  validateRuntimeSetting,
  type RuntimeSettingsContext,
} from '../src/index.js';
import { ConfigError, loadConfig } from '../src/server/index.js';

const PLUS_ID = 'jev-1.14.0+build5';
const AT = '2026-10-23T10:00:00.000Z';

const PROD: RuntimeSettingsContext = {
  production: true,
  providerHostAllowlist: ['api.typesafe.ai'],
  ollamaPricedModels: [],
};
const DEV: RuntimeSettingsContext = { ...PROD, production: false, providerHostAllowlist: [] };
const setting = (value: unknown, ctx: RuntimeSettingsContext) =>
  validateRuntimeSetting('engine.typesafe_model', value, ctx);

const API_ENV = {
  DATABASE_URL: 'postgres://bantoozi_app:app-secret@localhost:5433/bantoozi',
  SESSION_PEPPER: 'pepper',
};
function problemsOf(env: Record<string, string>): string[] {
  try {
    loadConfig({ process: 'api', env: { ...API_ENV, ...env } });
  } catch (error) {
    if (error instanceof ConfigError) return [...error.problems];
    throw error;
  }
  return [];
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAGMENTS = ['jev-', '1.2.3', '-rc1', '+build5', 'foo-', 'latest', 'jev-latest', '.', '-'];
const CHARS = ['a', 'Z', '0', ' ', '/', '+', ':', '_', '.', '-', 'é', '\u0000', '日'];

function randomId(rand: () => number): string {
  let s = '';
  const parts = 1 + Math.floor(rand() * 6);
  for (let i = 0; i < parts; i++) {
    s +=
      rand() < 0.6
        ? FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)]!
        : CHARS[Math.floor(rand() * CHARS.length)]!;
  }
  return s;
}

describe('one model-id grammar', () => {
  it('C1 an alias answer with build metadata is concrete, a model id and probe-recordable', () => {
    expect(MODEL_ID_PATTERN.test(PLUS_ID)).toBe(true);
    expect(isConcreteJevModel(PLUS_ID)).toBe(true);
    expect(
      EngineModelProbeSchema.parse({ requested: 'jev-latest', answered: PLUS_ID, ok: true, at: AT })
        .answered,
    ).toBe(PLUS_ID);
  });

  it('C2 the length bound is 64 characters everywhere', () => {
    const base = 'jev-1.0.0-';
    const at64 = base + 'a'.repeat(64 - base.length);
    const at65 = at64 + 'a';
    expect(at64).toHaveLength(64);
    for (const check of [
      isConcreteJevModel,
      isPinnedModel,
      (s: string) => MODEL_ID_PATTERN.test(s),
    ]) {
      expect(check(at64)).toBe(true);
      expect(check(at65)).toBe(false);
    }
    for (const bad of ['', ' x', '-x', '.x', 'a/b', 'a b', 'a'.repeat(65)]) {
      expect(MODEL_ID_PATTERN.test(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(MODEL_ID_PATTERN.test('a'.repeat(64))).toBe(true);
  });

  it('C3 concrete implies pinned implies a model id, and a concrete id is probe-recordable', () => {
    const rand = mulberry32(0x5eed);
    let concrete = 0;
    for (let i = 0; i < 20_000; i++) {
      const s = randomId(rand);
      if (isConcreteJevModel(s)) {
        concrete += 1;
        expect(isPinnedModel(s), s).toBe(true);
        expect(
          EngineModelProbeSchema.safeParse({
            requested: 'jev-latest',
            answered: s,
            ok: true,
            at: AT,
          }).success,
          s,
        ).toBe(true);
      }
      if (isPinnedModel(s)) expect(MODEL_ID_PATTERN.test(s), s).toBe(true);
      if (isModelAlias(s)) expect(MODEL_ID_PATTERN.test(s), s).toBe(true);
    }
    expect(concrete).toBeGreaterThan(20);
  });

  it('C3 answers a crafted 100000-character input in linear time', () => {
    const inputs = [
      `jev-1.0.0${'-a'.repeat(50_000)}`,
      `jev-${'a-'.repeat(50_000)}`,
      `a${'-a'.repeat(50_000)}1.2.`,
      '+'.repeat(100_000),
    ];
    for (const s of inputs) {
      const started = performance.now();
      isConcreteJevModel(s);
      isPinnedModel(s);
      isModelAlias(s);
      MODEL_ID_PATTERN.test(s);
      expect(performance.now() - started).toBeLessThan(200);
    }
  });

  it('C4 TYPESAFE_MODEL uses the shared grammar; Ollama names keep their own', () => {
    for (const model of ['a'.repeat(65), 'jev/1.0.0', '-jev']) {
      expect(problemsOf({ TYPESAFE_MODEL: model }), model).toEqual([
        'TYPESAFE_MODEL: invalid model id',
      ]);
    }
    for (const model of [PLUS_ID, 'jev-fake', 'a'.repeat(64)]) {
      expect(problemsOf({ TYPESAFE_MODEL: model }), model).toEqual([]);
    }
    const worker = { DATABASE_URL_WORKER: 'postgres://bantoozi_worker:w@localhost:5433/bantoozi' };
    expect(
      loadConfig({
        process: 'worker',
        env: { ...worker, OLLAMA_MODEL_FAST: 'hf.co/user/model:tag' },
      }).ollamaModelFast,
    ).toBe('hf.co/user/model:tag');
    expect(() =>
      loadConfig({ process: 'worker', env: { ...worker, OLLAMA_MODEL_STRONG: 'x'.repeat(201) } }),
    ).toThrow(ConfigError);
  });

  it('C5 the runtime setting engine.typesafe_model uses the shared grammar', () => {
    for (const v of ['x'.repeat(100), 'jev fake', 'a/b', 'x'.repeat(65)]) {
      expect(setting(v, DEV).ok, v).toBe(false);
      expect(setting(v, PROD).ok, v).toBe(false);
    }
    expect(setting('x'.repeat(100), DEV)).toEqual({ ok: false, message: 'not a valid model id' });
    for (const v of ['jev-fake', PLUS_ID]) expect(setting(v, DEV).ok, v).toBe(true);
    for (const v of ['foo-1.2.3', PLUS_ID, 'jev-latest']) expect(setting(v, PROD).ok, v).toBe(true);
    for (const v of ['jev-fake', 'jev-beta', 'latest']) expect(setting(v, PROD).ok, v).toBe(false);
  });
});
