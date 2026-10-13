import type { AdminSettings } from '@bantoozi/shared';

import { json } from '../api/fake-fetch.js';
import type { ApiRouteHandler } from '../support/app.js';
import { SETTINGS_VALUES, T1, adminRoutes, makeSettings } from './support.js';

/**
 * M8b-T10 ruler fixtures. Seams chosen by this ruler (change them here only, never in the tests):
 *
 * - `GET /admin/settings` answers `AdminSettings` plus `workers`: the FRESH worker heartbeats only
 *   (the API filters by the 90 s rule), each `{processId, at, pendingRestart, problems:[{key,message}]}`.
 *   Until the DTO has the field the strict response schema refuses it; that is the implementer's
 *   change (`AdminSettingsSchema.workers`, default `[]`).
 * - `values[key]` of a live runtime key is the STORED value or `null`; `defaults[key]` is the
 *   environment default (null when no worker can tell); `sources[key]` is stored | env | last_good.
 */

export const RUNTIME_DEFAULTS = {
  'engine.typesafe_model': 'jev-1.13.0',
  'engine.typesafe_base_url': 'https://jev.example.com',
  'engine.typesafe_price_per_mtok_usd': 0.5,
  'engine.concurrency': 8,
  'engine.llm_fallback_enabled': false,
  'engine.ollama_models': { fast: 'glm-5.3-flash', strong: 'glm-5.3' },
  'engine.ollama_base_url': 'https://ollama.example.com',
  'engine.ollama_max_concurrency': 4,
  'engine.prefilter_min_cards': 60,
  'ingest.max_age_days': 14,
  'fetch.limits': { timeoutMs: 20_000, maxBytes: 10 * 1024 * 1024 },
  'api.rate_limits_enabled': true,
  'translate.libretranslate_url': 'http://libretranslate:5000',
} as const;

export const RUNTIME_KEYS = Object.keys(RUNTIME_DEFAULTS) as (keyof typeof RUNTIME_DEFAULTS)[];

export interface WorkerStatus {
  processId: string;
  at: string;
  pendingRestart: boolean;
  problems: { key: string; message: string }[];
}

export function worker(over: Partial<WorkerStatus> = {}): WorkerStatus {
  return {
    processId: 'worker-1',
    at: T1,
    pendingRestart: false,
    problems: [],
    ...over,
  };
}

export interface RuntimeFixture {
  /** Stored values by key; every other runtime key is null (reads its environment default). */
  stored?: Partial<Record<keyof typeof RUNTIME_DEFAULTS, unknown>>;
  /** Sources by key; defaults to stored for a stored key, env otherwise. */
  sources?: Record<string, 'stored' | 'env' | 'last_good'>;
  workers?: WorkerStatus[];
}

export function runtimeSettings(fixture: RuntimeFixture = {}): AdminSettings & {
  workers: WorkerStatus[];
} {
  const stored = fixture.stored ?? {};
  const values: Record<string, unknown> = { ...SETTINGS_VALUES };
  const sources: Record<string, 'stored' | 'env' | 'last_good'> = {};
  for (const key of RUNTIME_KEYS) {
    const has = key in stored;
    values[key] = has ? stored[key] : null;
    sources[key] = fixture.sources?.[key] ?? (has ? 'stored' : 'env');
  }
  const base = makeSettings({
    values: values as AdminSettings['values'],
    stored: Object.keys(stored).map((key) => ({ key: key as never, updatedAt: T1 })),
    sources,
    defaults: { ...RUNTIME_DEFAULTS },
  });
  return { ...base, workers: fixture.workers ?? [worker()] };
}

/** Admin routes whose settings read answers the runtime fixture. */
export function runtimeRoutes(
  fixture: RuntimeFixture = {},
  over: Record<string, ApiRouteHandler> = {},
): Record<string, ApiRouteHandler> {
  return adminRoutes({ 'GET /admin/settings': () => json(200, runtimeSettings(fixture)), ...over });
}

/** A PATCH answer that applies the patch (null resets to the default) like the API does. */
export function patchAnswer(
  patch: Record<string, unknown>,
  fixture: RuntimeFixture = {},
): ReturnType<typeof json> {
  const stored = { ...(fixture.stored ?? {}) } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'acknowledge') continue;
    if (value === null) delete stored[key];
    else stored[key] = value;
  }
  return json(200, {
    ...runtimeSettings({
      ...(fixture.workers ? { workers: fixture.workers } : {}),
      stored: stored as NonNullable<RuntimeFixture['stored']>,
    }),
    changed: Object.keys(patch).filter((key) => key !== 'acknowledge'),
  });
}
