import {
  EngineModelImpactSchema,
  EngineModelPinSchema,
  EngineModelProbeSchema,
  EngineModelProbesSchema,
  EngineModelResolutionSchema,
  EngineModelWatchSchema,
  JEV_LATEST_ALIAS,
  type EngineModelImpact,
  type EngineModelPin,
  type EngineModelProbe,
  type EngineModelResolution,
  type EngineModelWatch,
} from '@bantoozi/shared';

import type { ApiHarness } from './harness.js';

/**
 * Seeds the worker-written model state the admin model gate reads (visible-learning §4.1, JEV-5):
 * `engine.model_probe`, `engine.model_resolution`, `engine.model_pin`, `engine.model_watch` and
 * `engine.model_impact`. Rows are written through the owner pool (the API cannot write them) and,
 * except `raw`, validated by the shared schemas so a fixture cannot drift from the contract.
 */

/** The keys `reset` deletes. */
export const MODEL_STATE_KEYS = [
  'engine.model_probe',
  'engine.model_resolution',
  'engine.model_pin',
  'engine.model_watch',
  'engine.model_impact',
] as const;

export interface ProbeSeed {
  /** The requested id; also the key of the entry. */
  requested: string;
  answered?: string;
  /** Default true. */
  ok?: boolean;
  error?: string;
  /** `at` = now + offsetMs (default 0: fresh). Ignored when `at` is given. */
  offsetMs?: number;
  at?: string;
}

export interface ModelStateSeed {
  /** Delete the five rows first. */
  reset?: boolean;
  /** One entry per requested id (at most 10; use `raw` for more). */
  probes?: readonly ProbeSeed[];
  resolution?: {
    model: string;
    resolvedAt?: string;
    checkedAt?: string;
    previous?: EngineModelResolution['previous'];
  };
  pin?: Omit<EngineModelPin, 'since'> & { since?: string };
  watch?: EngineModelWatch;
  impact?: EngineModelImpact;
  /** Written as given, after the validated rows: for garbage-row cases. */
  raw?: Partial<Record<(typeof MODEL_STATE_KEYS)[number], unknown>>;
}

const SINCE = '2026-10-01T00:00:00.000Z';

/** A probe entry stamped `offsetMs` from now (negative = in the past). */
export function probeEntry(seed: ProbeSeed, nowMs = Date.now()): EngineModelProbe {
  return EngineModelProbeSchema.parse({
    requested: seed.requested,
    ...(seed.answered === undefined ? {} : { answered: seed.answered }),
    ok: seed.ok ?? true,
    at: seed.at ?? new Date(nowMs + (seed.offsetMs ?? 0)).toISOString(),
    ...(seed.error === undefined ? {} : { error: seed.error }),
  });
}

async function put(h: Pick<ApiHarness, 'owner'>, key: string, value: unknown): Promise<void> {
  await h.owner.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)],
  );
}

export async function seedModelState(
  h: Pick<ApiHarness, 'owner'>,
  seed: ModelStateSeed = {},
): Promise<void> {
  if (seed.reset === true) {
    await h.owner.query('DELETE FROM settings WHERE key = ANY($1::text[])', [
      [...MODEL_STATE_KEYS],
    ]);
  }
  if (seed.probes !== undefined) {
    const now = Date.now();
    const entries = seed.probes.map((p) => [p.requested, probeEntry(p, now)] as const);
    await put(h, 'engine.model_probe', EngineModelProbesSchema.parse(Object.fromEntries(entries)));
  }
  if (seed.resolution !== undefined) {
    const at = new Date().toISOString();
    await put(
      h,
      'engine.model_resolution',
      EngineModelResolutionSchema.parse({
        alias: JEV_LATEST_ALIAS,
        resolvedAt: at,
        checkedAt: at,
        ...seed.resolution,
      }),
    );
  }
  if (seed.pin !== undefined) {
    await put(h, 'engine.model_pin', EngineModelPinSchema.parse({ since: SINCE, ...seed.pin }));
  }
  if (seed.watch !== undefined) {
    await put(h, 'engine.model_watch', EngineModelWatchSchema.parse(seed.watch));
  }
  if (seed.impact !== undefined) {
    await put(h, 'engine.model_impact', EngineModelImpactSchema.parse(seed.impact));
  }
  for (const [key, value] of Object.entries(seed.raw ?? {})) await put(h, key, value);
}
