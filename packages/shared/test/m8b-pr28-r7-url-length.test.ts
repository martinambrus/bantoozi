import { describe, expect, it } from 'vitest';

import { AdminSettingsValuesSchema, ENV_RANGES } from '../src/index.js';
import { loadConfig } from '../src/server/index.js';

/**
 * PR #28 round 7: the environment and the settings response agree on how long a URL may be. An env
 * URL the config accepts must be showable (it used to 500 the response above 500 characters), and
 * one beyond the shared bound is refused at load.
 */
const WORKER_URL = 'postgres://bantoozi_worker:worker-secret@localhost:5433/bantoozi';
const api = { DATABASE_URL_WORKER: WORKER_URL };
const urlOfLength = (n: number) =>
  `https://jev.example.com/${'a'.repeat(n - 'https://jev.example.com/'.length)}`;
const MAX = ENV_RANGES.urlLength.max;

describe('env URL length (single source: ENV_RANGES.urlLength)', () => {
  it('a 1500-character env URL loads and the response schema can show it', () => {
    const url = urlOfLength(1500);
    const config = loadConfig({ process: 'worker', env: { ...api, TYPESAFE_BASE_URL: url } });
    expect(config.typesafeBaseUrl).toBe(url);
    const shape = AdminSettingsValuesSchema.shape;
    expect(shape['engine.typesafe_base_url'].safeParse(url).success).toBe(true);
    expect(shape['engine.ollama_base_url'].safeParse(url).success).toBe(true);
    expect(shape['translate.libretranslate_url'].safeParse(url).success).toBe(true);
  });

  it('the bound itself loads and shows; one more is refused by both', () => {
    const at = urlOfLength(MAX);
    const over = urlOfLength(MAX + 1);
    expect(() =>
      loadConfig({ process: 'worker', env: { ...api, TYPESAFE_BASE_URL: at } }),
    ).not.toThrow();
    expect(() =>
      loadConfig({ process: 'worker', env: { ...api, TYPESAFE_BASE_URL: over } }),
    ).toThrow(/TYPESAFE_BASE_URL/);
    const shape = AdminSettingsValuesSchema.shape;
    expect(shape['engine.typesafe_base_url'].safeParse(at).success).toBe(true);
    expect(shape['engine.typesafe_base_url'].safeParse(over).success).toBe(false);
  });
});
