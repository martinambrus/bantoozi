import {
  RUNTIME_SETTING_KEYS,
  effectiveRuntimeSettings,
  type RuntimeEnvDefaults,
  type RuntimeSettingsContext,
  type RuntimeSettingsSnapshot,
} from '@bantoozi/shared';

import type { Executor } from './client.js';
import { readStoredSettings } from './settings.js';

/** The stored rows of the live runtime settings, read in one statement. */
export function runtimeSettingsLoader(db: Executor): () => Promise<Map<string, unknown>> {
  return () => readStoredSettings(db, RUNTIME_SETTING_KEYS);
}

export interface RuntimeSettingsCache {
  get(): Promise<RuntimeSettingsSnapshot>;
  invalidate(): void;
}

/**
 * TTL cache of the effective runtime settings (M8b-T1): single-flight refresh; a failed refresh serves
 * the last good snapshot (problem key `*`) and is retried on the next read; `invalidate` drops the
 * snapshot and any in-flight refresh so the next read reloads.
 */
export function createRuntimeSettingsCache(options: {
  load: () => Promise<ReadonlyMap<string, unknown>>;
  env: RuntimeEnvDefaults;
  context: RuntimeSettingsContext;
  ttlMs?: number;
  now?: () => number;
}): RuntimeSettingsCache {
  const ttlMs = options.ttlMs ?? 10_000;
  const now = options.now ?? Date.now;
  let snapshot: RuntimeSettingsSnapshot | undefined;
  let loadedAt = 0;
  let fresh = false;
  let inflight: Promise<RuntimeSettingsSnapshot> | undefined;
  let generation = 0;

  const refresh = (): Promise<RuntimeSettingsSnapshot> => {
    const gen = generation;
    const run = (async () => {
      let rows: ReadonlyMap<string, unknown>;
      try {
        rows = await options.load();
      } catch (error) {
        if (!snapshot) throw error;
        const message = error instanceof Error ? error.message : 'settings load failed';
        return { ...snapshot, problems: [...snapshot.problems, { key: '*', message }] };
      }
      const next = effectiveRuntimeSettings(rows, options.env, options.context, snapshot?.values);
      if (gen === generation) {
        snapshot = next;
        loadedAt = now();
        fresh = true;
      }
      return next;
    })();
    const tracked = run.finally(() => {
      if (inflight === tracked) inflight = undefined;
    });
    inflight = tracked;
    return tracked;
  };

  return {
    get() {
      if (snapshot && fresh && now() - loadedAt < ttlMs) return Promise.resolve(snapshot);
      return inflight ?? refresh();
    },
    invalidate() {
      generation += 1;
      fresh = false;
      inflight = undefined;
    },
  };
}
