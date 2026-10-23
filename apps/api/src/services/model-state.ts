import {
  AppError,
  ENGINE_MODEL_PROBES_MAX,
  EngineModelPinSchema,
  EngineModelProbeSchema,
  EngineModelResolutionSchema,
  MODEL_ID_PATTERN,
  isModelAlias,
  planModelChange,
  type EngineModelPin,
  type EngineModelProbe,
  type EngineModelResolution,
  type ModelChangePlan,
} from '@bantoozi/shared';

export const MODEL_PROBE_KEY = 'engine.model_probe';
export const MODEL_RESOLUTION_KEY = 'engine.model_resolution';
export const MODEL_PIN_KEY = 'engine.model_pin';
export const MODEL_STATE_KEYS = [MODEL_PROBE_KEY, MODEL_RESOLUTION_KEY, MODEL_PIN_KEY] as const;

export interface StoredModelState {
  probes: Record<string, EngineModelProbe>;
  resolution: EngineModelResolution | null;
  pin: EngineModelPin | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reads the model rows leniently: an unreadable row or probe entry counts as absent. */
export function readModelState(rows: readonly { key: string; value: unknown }[]): StoredModelState {
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  const valid: EngineModelProbe[] = [];
  const stored = byKey.get(MODEL_PROBE_KEY);
  if (isRecord(stored)) {
    for (const [key, entry] of Object.entries(stored)) {
      const parsed = EngineModelProbeSchema.safeParse(entry);
      if (parsed.success && parsed.data.requested === key) valid.push(parsed.data);
    }
  }
  valid.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const probes = Object.create(null) as Record<string, EngineModelProbe>;
  for (const probe of valid.slice(0, ENGINE_MODEL_PROBES_MAX)) probes[probe.requested] = probe;
  return {
    probes,
    resolution: EngineModelResolutionSchema.safeParse(byKey.get(MODEL_RESOLUTION_KEY)).data ?? null,
    pin: EngineModelPinSchema.safeParse(byKey.get(MODEL_PIN_KEY)).data ?? null,
  };
}

/**
 * Refuses a change of the TypeSafe model to `model` unless a fresh probe confirms it, and returns
 * what the change does to the data.
 */
export function gateModelChange(
  state: StoredModelState,
  setting: string,
  model: string,
  nowMs: number,
): Extract<ModelChangePlan, { state: 'ok' }> {
  if (!MODEL_ID_PATTERN.test(model)) {
    throw new AppError('VALIDATION_FAILED', 'Invalid setting value', {
      details: { key: 'engine.typesafe_model', message: 'not a model id that can be probed' },
    });
  }
  const plan = planModelChange({ setting, ...state }, model, nowMs);
  if (plan.state === 'required') {
    throw new AppError('CONFLICT', 'No recent successful probe of this model', {
      details: { reason: 'model_probe_required', model },
    });
  }
  if (plan.state === 'failed') {
    const { probe } = plan;
    throw new AppError('CONFLICT', 'Jev did not confirm this model', {
      details: {
        reason: 'model_probe_failed',
        model,
        ...(probe.answered === undefined ? {} : { answered: probe.answered }),
        error: probe.error ?? (isModelAlias(model) ? 'alias_unresolved' : 'model_mismatch'),
        at: probe.at,
      },
    });
  }
  return plan;
}
