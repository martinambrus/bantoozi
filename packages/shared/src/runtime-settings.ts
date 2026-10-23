import { JEV_LATEST_ALIAS, isModelAlias, isModelId, isPinnedModel } from './model-id.js';
import { EngineModelResolutionSchema, parseSetting, type SettingKey } from './settings.js';

/**
 * Live runtime settings (M8b-T1, spec 01 §3, spec 02 §2). The stored `settings` row of each key
 * overrides the matching environment value; `null` or no row means the environment value. A row that
 * fails validation is ignored (the previous good value, else the environment value) and reported.
 */

export const RUNTIME_SETTING_KEYS = [
  'engine.typesafe_model',
  'engine.typesafe_base_url',
  'engine.typesafe_price_per_mtok_usd',
  'engine.concurrency',
  'engine.llm_fallback_enabled',
  'engine.ollama_models',
  'engine.ollama_base_url',
  'engine.ollama_max_concurrency',
  'engine.prefilter_min_cards',
  'engine.auto_analysis_daily_cap',
  'ingest.max_age_days',
  'fetch.limits',
  'api.rate_limits_enabled',
  'translate.libretranslate_url',
] as const satisfies readonly SettingKey[];
export type RuntimeSettingKey = (typeof RUNTIME_SETTING_KEYS)[number];

/** Stored rows the effective values derive from but that are not live settings themselves. */
export const RUNTIME_SETTINGS_EXTRA_KEYS = [
  'engine.model_resolution',
] as const satisfies readonly SettingKey[];

/**
 * A local Ollama app names a cloud model `<model>-cloud` (`gemma4:31b-cloud`); the Ollama Cloud API
 * that Bantoozi calls and its price table use the bare name, so the suffix is dropped.
 */
export function normalizeOllamaModel(model: string): string {
  return model.endsWith('-cloud') && model.length > '-cloud'.length
    ? model.slice(0, -'-cloud'.length)
    : model;
}

export interface RuntimeSettingsContext {
  production: boolean;
  /** `host` or `host:port` entries; an entry without a port matches the host on any port. */
  providerHostAllowlist: readonly string[];
  /** Ollama model names that have a price in the price table. */
  ollamaPricedModels: readonly string[];
}

/** The environment-derived defaults of the runtime settings. */
export interface RuntimeEnvDefaults {
  typesafeModel: string;
  typesafeBaseUrl: string;
  typesafePricePerMtokUsd: number;
  engineConcurrency: number;
  llmFallbackEnabled: boolean;
  ollamaModelFast: string;
  ollamaModelStrong: string;
  ollamaBaseUrl: string;
  ollamaMaxConcurrency: number;
  prefilterMinCards: number;
  autoAnalysisDailyCap: number;
  ingestMaxAgeDays: number;
  fetchTimeoutMs: number;
  fetchMaxBytes: number;
  rateLimitsEnabled: boolean;
  libretranslateUrl: string;
}

export interface RuntimeSettingsValues {
  typesafeModel: string;
  /** The concrete release `jev-latest` resolved to; null for a concrete setting or an unresolved alias. */
  typesafeResolvedModel: string | null;
  typesafeBaseUrl: string;
  typesafePricePerMtokUsd: number;
  engineConcurrency: number;
  llmFallbackEnabled: boolean;
  ollamaModels: { fast: string; strong: string };
  ollamaBaseUrl: string;
  ollamaMaxConcurrency: number;
  prefilterMinCards: number;
  autoAnalysisDailyCap: number;
  ingestMaxAgeDays: number;
  fetchLimits: { timeoutMs: number; maxBytes: number };
  rateLimitsEnabled: boolean;
  libretranslateUrl: string;
}

export type RuntimeSettingSource = 'env' | 'stored' | 'last_good';
export interface RuntimeSettingProblem {
  key: string;
  message: string;
}
export interface RuntimeSettingsSnapshot {
  values: RuntimeSettingsValues;
  sources: Record<string, RuntimeSettingSource>;
  problems: RuntimeSettingProblem[];
}

export type RuntimeSettingValidation =
  { ok: true; value: unknown } | { ok: false; message: string };

function hostAllowed(url: URL, allowlist: readonly string[]): boolean {
  const host = url.host.toLowerCase();
  const hostname = url.hostname.toLowerCase();
  return allowlist.some((entry) => {
    const e = entry.trim().toLowerCase();
    if (!e) return false;
    return e.includes(':') && !e.startsWith('[') ? e === host : e === hostname;
  });
}

function checkUrl(
  value: string,
  ctx: RuntimeSettingsContext,
  opts: { httpsOnly: boolean },
): RuntimeSettingValidation {
  const url = new URL(value); // the schema has already accepted it
  if (ctx.production) {
    if (opts.httpsOnly && url.protocol !== 'https:') {
      return { ok: false, message: 'the URL must use https in production' };
    }
    if (!hostAllowed(url, ctx.providerHostAllowlist)) {
      return { ok: false, message: 'the URL host is not on PROVIDER_HOST_ALLOWLIST' };
    }
  }
  return { ok: true, value: value.replace(/\/+$/, '') };
}

/** Validate a value for a live runtime key; `null` always resets to the environment default. */
export function validateRuntimeSetting(
  key: RuntimeSettingKey,
  value: unknown,
  ctx: RuntimeSettingsContext,
): RuntimeSettingValidation {
  let parsed: unknown;
  try {
    parsed = parseSetting(key, value);
  } catch (error) {
    const issue = (error as { issues?: { message?: string }[] }).issues?.[0]?.message;
    return { ok: false, message: issue ?? 'invalid value' };
  }
  if (parsed === null) return { ok: true, value: null };
  switch (key) {
    case 'engine.typesafe_model':
      if (ctx.production && !isPinnedModel(parsed as string) && !isModelAlias(parsed as string)) {
        return {
          ok: false,
          message: `production needs a pinned model version such as jev-1.13.0, or ${JEV_LATEST_ALIAS}`,
        };
      }
      if (!isModelId(parsed as string)) return { ok: false, message: 'not a valid model id' };
      return { ok: true, value: parsed };
    case 'engine.typesafe_base_url':
    case 'engine.ollama_base_url':
      return checkUrl(parsed as string, ctx, { httpsOnly: true });
    case 'translate.libretranslate_url':
      return checkUrl(parsed as string, ctx, { httpsOnly: false });
    case 'engine.ollama_models': {
      const raw = parsed as { fast: string; strong: string };
      const models = {
        fast: normalizeOllamaModel(raw.fast),
        strong: normalizeOllamaModel(raw.strong),
      };
      for (const m of [models.fast, models.strong]) {
        if (!ctx.ollamaPricedModels.includes(m)) {
          return { ok: false, message: `model "${m}" has no price in the price table` };
        }
      }
      return { ok: true, value: models };
    }
    case 'engine.typesafe_price_per_mtok_usd':
      if (ctx.production && (parsed as number) <= 0) {
        return { ok: false, message: 'the price must be greater than 0 in production' };
      }
      return { ok: true, value: parsed };
    default:
      return { ok: true, value: parsed };
  }
}

const FIELDS: {
  key: RuntimeSettingKey;
  field: keyof RuntimeSettingsValues;
  fromEnv: (env: RuntimeEnvDefaults) => unknown;
}[] = [
  { key: 'engine.typesafe_model', field: 'typesafeModel', fromEnv: (e) => e.typesafeModel },
  { key: 'engine.typesafe_base_url', field: 'typesafeBaseUrl', fromEnv: (e) => e.typesafeBaseUrl },
  {
    key: 'engine.typesafe_price_per_mtok_usd',
    field: 'typesafePricePerMtokUsd',
    fromEnv: (e) => e.typesafePricePerMtokUsd,
  },
  { key: 'engine.concurrency', field: 'engineConcurrency', fromEnv: (e) => e.engineConcurrency },
  {
    key: 'engine.llm_fallback_enabled',
    field: 'llmFallbackEnabled',
    fromEnv: (e) => e.llmFallbackEnabled,
  },
  {
    key: 'engine.ollama_models',
    field: 'ollamaModels',
    fromEnv: (e) => ({ fast: e.ollamaModelFast, strong: e.ollamaModelStrong }),
  },
  { key: 'engine.ollama_base_url', field: 'ollamaBaseUrl', fromEnv: (e) => e.ollamaBaseUrl },
  {
    key: 'engine.ollama_max_concurrency',
    field: 'ollamaMaxConcurrency',
    fromEnv: (e) => e.ollamaMaxConcurrency,
  },
  {
    key: 'engine.prefilter_min_cards',
    field: 'prefilterMinCards',
    fromEnv: (e) => e.prefilterMinCards,
  },
  {
    key: 'engine.auto_analysis_daily_cap',
    field: 'autoAnalysisDailyCap',
    fromEnv: (e) => e.autoAnalysisDailyCap,
  },
  { key: 'ingest.max_age_days', field: 'ingestMaxAgeDays', fromEnv: (e) => e.ingestMaxAgeDays },
  {
    key: 'fetch.limits',
    field: 'fetchLimits',
    fromEnv: (e) => ({ timeoutMs: e.fetchTimeoutMs, maxBytes: e.fetchMaxBytes }),
  },
  {
    key: 'api.rate_limits_enabled',
    field: 'rateLimitsEnabled',
    fromEnv: (e) => e.rateLimitsEnabled,
  },
  {
    key: 'translate.libretranslate_url',
    field: 'libretranslateUrl',
    fromEnv: (e) => e.libretranslateUrl,
  },
];

/**
 * The effective runtime settings: env default, overridden by a valid stored row; an invalid row is
 * ignored (the `previous` value, else env) and reported in `problems`.
 */
export function effectiveRuntimeSettings(
  stored: ReadonlyMap<string, unknown>,
  env: RuntimeEnvDefaults,
  ctx: RuntimeSettingsContext,
  previous?: RuntimeSettingsValues,
): RuntimeSettingsSnapshot {
  const values: Record<string, unknown> = {};
  const sources: Record<string, RuntimeSettingSource> = {};
  const problems: RuntimeSettingProblem[] = [];
  for (const { key, field, fromEnv } of FIELDS) {
    const row = stored.get(key);
    if (row === undefined || row === null) {
      values[field] = fromEnv(env);
      sources[key] = 'env';
      continue;
    }
    const result = validateRuntimeSetting(key, row, ctx);
    if (result.ok && result.value !== null) {
      values[field] = result.value;
      sources[key] = 'stored';
    } else if (result.ok) {
      values[field] = fromEnv(env);
      sources[key] = 'env';
    } else {
      problems.push({ key, message: result.message });
      if (previous) {
        values[field] = previous[field];
        sources[key] = 'last_good';
      } else {
        values[field] = fromEnv(env);
        sources[key] = 'env';
      }
    }
  }
  values.typesafeResolvedModel = null;
  const resolutionRow = stored.get('engine.model_resolution');
  if (
    typeof values.typesafeModel === 'string' &&
    isModelAlias(values.typesafeModel) &&
    resolutionRow !== undefined &&
    resolutionRow !== null
  ) {
    const parsed = EngineModelResolutionSchema.safeParse(resolutionRow);
    if (parsed.success && parsed.data.alias === values.typesafeModel) {
      values.typesafeResolvedModel = parsed.data.model;
    } else {
      problems.push({
        key: 'engine.model_resolution',
        message: parsed.success
          ? 'the stored resolution is for another alias'
          : (parsed.error.issues[0]?.message ?? 'invalid value'),
      });
    }
  }
  return { values: values as unknown as RuntimeSettingsValues, sources, problems };
}

/** The concrete model id this process may call: the configured one, or an alias's resolution (null when unresolved). */
export function effectiveTypesafeModel(values: RuntimeSettingsValues): string | null {
  return isModelAlias(values.typesafeModel) ? values.typesafeResolvedModel : values.typesafeModel;
}
