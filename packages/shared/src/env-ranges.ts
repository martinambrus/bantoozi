/**
 * The numeric ranges the environment accepts (`server/config.ts`) for the keys that are also live
 * runtime settings. They are wider than the runtime-setting write bounds (`settings.ts`) on purpose:
 * an admin may only store a value inside the narrower bounds, but the settings response shows any
 * value the environment could have set as a default.
 */
export const ENV_RANGES = {
  engineConcurrency: { min: 1, max: 256 },
  ollamaMaxConcurrency: { min: 1, max: 64 },
  prefilterMinCards: { min: 1, max: 1_000_000 },
  ingestMaxAgeDays: { min: 1, max: 3650 },
  fetchTimeoutMs: { min: 100, max: 600_000 },
  fetchMaxBytes: { min: 1024, max: 1024 ** 3 },
  /** Characters of an environment http(s) URL; the settings response shows any URL that passes. */
  urlLength: { min: 1, max: 2048 },
} as const;
