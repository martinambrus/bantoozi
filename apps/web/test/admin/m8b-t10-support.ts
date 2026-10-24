import type { AdminEngineModel, AdminSettings, EngineModelProbe } from '@bantoozi/shared';

import { json } from '../api/fake-fetch.js';
import { bodyOf, type ApiRouteHandler } from '../support/app.js';
import {
  MODEL_NOW,
  RUNTIME_DEFAULTS,
  SETTINGS_VALUES,
  T1,
  adminRoutes,
  makeModelStatus,
  makeSettings,
  modelProbe,
} from './support.js';

/**
 * M8b-T10 ruler fixtures. Seams chosen by this ruler (change them here only, never in the tests):
 *
 * - `GET /admin/settings` answers `AdminSettings` plus `workers`: the FRESH worker heartbeats only
 *   (the API filters by the 90 s rule), each `{processId, at, pendingRestart, problems:[{key,message}]}`.
 *   Until the DTO has the field the strict response schema refuses it; that is the implementer's
 *   change (`AdminSettingsSchema.workers`, default `[]`).
 * - `values[key]` of a live runtime key is its effective value; `defaults[key]` is the
 *   environment default (null when no worker can tell); `sources[key]` is stored | env | last_good.
 */

export { RUNTIME_DEFAULTS } from './support.js';

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
  /** Stored values by key; every other runtime key reads its effective environment default. */
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
    values[key] = has ? stored[key] : RUNTIME_DEFAULTS[key];
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
    queued: [],
  });
}

// ── The model editor's API (JEV-5): GET /admin/engine/model, POST model-probe and model-check ──────

export interface ModelServerOptions {
  /** The status read (1 = the first one after the probe request) on which the probe lands; null never. */
  probeOnRead?: number | null;
  /** What a landing probe says; by default it confirms the requested id (the alias: jev-1.14.0). */
  probeAnswer?: (model: string) => Partial<EngineModelProbe>;
  /** The status read after the check request on which the check ends; null never. */
  checkOnRead?: number | null;
  /** How that check ends: an answer for `model`, or a failure with `error`. */
  checkResult?: { ok: true; model?: string } | { ok: false; error: string };
}

/**
 * A mutable model status behind the three model routes. The status `now` is the API clock: it starts
 * at MODEL_NOW and moves with the (fake) timers, whatever the browser clock says. A probe or check
 * request starts counting the status reads that follow it, and lands its result on the configured
 * read; `onRead` lets a test do something else on a given read.
 */
export interface ModelServer {
  status: AdminEngineModel;
  /** The model of each POST /admin/engine/model-probe, in order. */
  probes: string[];
  /** How many POST /admin/engine/model-check were made. */
  checks: number;
  /** Status reads answered, all of them. */
  reads: number;
  /** Status reads since the last probe or check request. */
  readsSincePost: number;
  /** Runs before a status read is answered, with the number of reads since the last request. */
  onRead: ((server: ModelServer, readsSincePost: number) => void) | null;
  /** The API clock in ms. */
  apiNow: () => number;
  landProbe: (model: string, over?: Partial<EngineModelProbe>) => void;
  landCheck: (result?: NonNullable<ModelServerOptions['checkResult']>) => void;
  /** The three model routes (and nothing else): spread them into `runtimeRoutes(fixture, ...)`. */
  routes: () => Record<string, ApiRouteHandler>;
  /** A PATCH /admin/settings answer that also moves the status setting like the API does. */
  patched: (patch: Record<string, unknown>, fixture?: RuntimeFixture) => ReturnType<typeof json>;
}

export function modelServer(
  initial: Partial<AdminEngineModel> = {},
  options: ModelServerOptions = {},
): ModelServer {
  const { probeOnRead = null, checkOnRead = null } = options;
  let startedAt: number | null = null;
  let pending: 'probe' | 'check' | null = null;
  const iso = (ms: number) => new Date(ms).toISOString();

  const server: ModelServer = {
    status: makeModelStatus(initial),
    probes: [],
    checks: 0,
    reads: 0,
    readsSincePost: 0,
    onRead: null,
    apiNow: () => Date.parse(MODEL_NOW) + (Date.now() - (startedAt ??= Date.now())),
    landProbe: (model, over = {}) => {
      server.status.probes = {
        ...server.status.probes,
        [model]: modelProbe(model, {
          at: iso(server.apiNow()),
          ...(model === 'jev-latest' ? { answered: 'jev-1.14.0' } : {}),
          ...over,
        }),
      };
    },
    landCheck: (result = options.checkResult ?? { ok: true }) => {
      const at = iso(server.apiNow());
      if (result.ok) {
        const before = server.status.resolution;
        server.status.resolution = {
          alias: 'jev-latest',
          model: result.model ?? before?.model ?? 'jev-1.13.0',
          resolvedAt: before?.resolvedAt ?? at,
          checkedAt: at,
        };
        server.status.watch = { lastCheck: { at, ok: true } };
      } else {
        server.status.watch = { lastCheck: { at, ok: false, error: result.error } };
      }
    },
    routes: () => ({
      'GET /admin/engine/model': () => {
        server.reads += 1;
        if (pending !== null) server.readsSincePost += 1;
        server.onRead?.(server, server.readsSincePost);
        if (pending === 'probe' && probeOnRead !== null && server.readsSincePost === probeOnRead) {
          const model = server.probes.at(-1)!;
          server.landProbe(model, options.probeAnswer?.(model) ?? {});
          pending = null;
        }
        if (pending === 'check' && checkOnRead !== null && server.readsSincePost === checkOnRead) {
          server.landCheck();
          pending = null;
        }
        return json(200, { ...server.status, now: iso(server.apiNow()) });
      },
      'POST /admin/engine/model-probe': (request) => {
        server.probes.push((bodyOf(request) as { model: string }).model);
        pending = 'probe';
        server.readsSincePost = 0;
        return json(202, { queued: true });
      },
      'POST /admin/engine/model-check': () => {
        server.checks += 1;
        pending = 'check';
        server.readsSincePost = 0;
        return json(202, { queued: true });
      },
    }),
    patched: (patch, fixture = {}) => {
      const key = 'engine.typesafe_model';
      if (key in patch) {
        const value = patch[key];
        server.status.setting =
          value === null
            ? { value: RUNTIME_DEFAULTS[key], source: 'env' }
            : { value: value as string, source: 'stored' };
      }
      return patchAnswer(patch, fixture);
    },
  };
  return server;
}
