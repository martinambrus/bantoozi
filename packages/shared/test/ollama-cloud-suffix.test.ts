import { describe, expect, it } from 'vitest';

import {
  normalizeOllamaModel,
  validateRuntimeSetting,
  type RuntimeSettingsContext,
} from '../src/index.js';
import { loadConfig } from '../src/server/index.js';

/**
 * A local Ollama app names cloud models `<model>-cloud`; the Ollama Cloud API and the price table
 * use the bare name, so the settings and the env accept the suffix and drop it.
 */

const DEV: RuntimeSettingsContext = {
  production: false,
  providerHostAllowlist: [],
  ollamaPricedModels: ['glm-5.3-flash', 'glm-5.3', 'gemma4:31b'],
};

describe('Ollama -cloud model suffix', () => {
  it('drops only a trailing -cloud', () => {
    expect(normalizeOllamaModel('gemma4:31b-cloud')).toBe('gemma4:31b');
    expect(normalizeOllamaModel('gemma4:31b')).toBe('gemma4:31b');
    expect(normalizeOllamaModel('cloud-model')).toBe('cloud-model');
    expect(normalizeOllamaModel('-cloud')).toBe('-cloud');
  });

  it('accepts and stores the bare name for engine.ollama_models', () => {
    expect(
      validateRuntimeSetting(
        'engine.ollama_models',
        { fast: 'gemma4:31b-cloud', strong: 'gemma4:31b-cloud' },
        DEV,
      ),
    ).toEqual({ ok: true, value: { fast: 'gemma4:31b', strong: 'gemma4:31b' } });
  });

  it('still refuses an unpriced model with the suffix (control)', () => {
    const checked = validateRuntimeSetting(
      'engine.ollama_models',
      { fast: 'unpriced-9-cloud', strong: 'glm-5.3' },
      DEV,
    );
    expect(checked).toEqual({
      ok: false,
      message: 'model "unpriced-9" has no price in the price table',
    });
  });

  it('drops the suffix from OLLAMA_MODEL_FAST and OLLAMA_MODEL_STRONG', () => {
    const config = loadConfig({
      process: 'worker',
      env: {
        DATABASE_URL_WORKER: 'postgres://w:w@localhost:5432/bantoozi',
        OLLAMA_MODEL_FAST: 'gemma4:31b-cloud',
        OLLAMA_MODEL_STRONG: 'glm-5.3-cloud',
      },
    });
    expect(config.ollamaModelFast).toBe('gemma4:31b');
    expect(config.ollamaModelStrong).toBe('glm-5.3');
  });
});
