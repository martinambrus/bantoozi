import type { Database } from '@bantoozi/db';

import { recordModelProbe, type ModelProber } from '../model-probe.js';
import { nowOf, type HandlerLogger } from './deps.js';
import type { QueueHandler } from './index.js';

/** The probe's own deadline: two attempts of 30 s plus a short wait. */
export const MODEL_PROBE_DEADLINE_MS = 60_000;

export interface ModelProbeHandlerDeps {
  db: Database;
  prober: ModelProber;
  logger: HandlerLogger;
  now?: () => Date;
}

/** `engine.model-probe {model}`: probe the model and record the result; a failure is recorded, not thrown. */
export function createModelProbeHandler(
  deps: ModelProbeHandlerDeps,
): QueueHandler<'engine.model-probe'> {
  const { db, prober, logger } = deps;
  return async ({ model }) => {
    let result;
    try {
      result = await prober.probe(model, { signal: AbortSignal.timeout(MODEL_PROBE_DEADLINE_MS) });
    } catch (error) {
      logger.warn(
        { model, err: error instanceof Error ? error.message : 'unknown' },
        'model probe rejected',
      );
      result = {
        requested: model,
        ok: false,
        at: nowOf(deps).toISOString(),
        error: 'internal_error',
      };
    }
    await recordModelProbe(db, result);
  };
}
