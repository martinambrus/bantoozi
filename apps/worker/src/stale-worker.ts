import { readStoredSetting, type Executor } from '@bantoozi/db';

import type { ClassificationDeps } from './handlers/deps.js';

/**
 * A worker whose process values are not the current ones (M8b-T5, PR #28 round 4): a restart-class
 * setting or the model pin moved, so this process, which has not restarted yet, must neither ask its
 * old model nor write its answers. The job fails and the queue retries it after `retryDelaySeconds`,
 * by when a drained worker has restarted.
 */
export class StaleWorkerError extends Error {
  readonly retryDelaySeconds = 30;

  constructor(
    readonly processModel: string,
    readonly pinnedModel: string,
    readonly reason: 'pin' | 'restart_settings' = 'pin',
  ) {
    super(
      reason === 'pin'
        ? `This worker runs ${processModel} but the pinned model is ${pinnedModel}`
        : `This worker runs ${processModel} but a restart-class setting changed since it started`,
    );
    this.name = 'StaleWorkerError';
  }
}

type PinLlm = { fast?: unknown; strong?: unknown } | undefined | null;

const llmKey = (llm: PinLlm): string | null =>
  llm && typeof llm.fast === 'string' && typeof llm.strong === 'string'
    ? `${llm.fast}\u0000${llm.strong}`
    : null;

/**
 * Throws {@link StaleWorkerError} when this process is not what the database now asks for: (1) the
 * restart fingerprint of the current effective settings (one fresh read, the condition of
 * `pendingRestart`) differs from the one the process booted with, or (2) `engine.model_pin` names
 * another model or another fallback state and model pair than this process records. No pin row: the
 * pin is not stale.
 */
export async function assertWorkerCurrent(
  db: Executor,
  classification: Pick<ClassificationDeps, 'primaryModel' | 'currentness'>,
): Promise<void> {
  const processModel = classification.primaryModel;
  const currentness = classification.currentness;
  if (
    currentness !== undefined &&
    (await currentness.restartFingerprint()) !== currentness.fingerprint
  ) {
    throw new StaleWorkerError(processModel, processModel, 'restart_settings');
  }
  const stored = await readStoredSetting(db, 'engine.model_pin');
  if (stored === undefined || stored === null) return;
  const pin = stored as { model?: unknown; llm?: PinLlm };
  if (typeof pin.model === 'string' && pin.model !== '' && pin.model !== processModel) {
    throw new StaleWorkerError(processModel, pin.model);
  }
  if (currentness !== undefined && llmKey(pin.llm) !== llmKey(currentness.pin.llm)) {
    throw new StaleWorkerError(processModel, processModel, 'restart_settings');
  }
}
