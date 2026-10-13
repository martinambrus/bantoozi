import { readStoredSetting, type Executor } from '@bantoozi/db';

/**
 * A worker whose process model is not the pinned one (M8b-T5): the pin moved to a new model, so
 * this process, which has not restarted yet, must neither ask the old model nor write its answers.
 * The job fails and the queue retries it after `retryDelaySeconds`, by when a drained worker has
 * restarted.
 */
export class StaleWorkerError extends Error {
  readonly retryDelaySeconds = 30;

  constructor(
    readonly processModel: string,
    readonly pinnedModel: string,
  ) {
    super(`This worker runs ${processModel} but the pinned model is ${pinnedModel}`);
    this.name = 'StaleWorkerError';
  }
}

/** Throws {@link StaleWorkerError} when `engine.model_pin` names another model; no pin: not stale. */
export async function assertWorkerCurrent(db: Executor, processModel: string): Promise<void> {
  const stored = await readStoredSetting(db, 'engine.model_pin');
  if (stored === undefined || stored === null) return;
  const model = (stored as { model?: unknown }).model;
  if (typeof model === 'string' && model !== '' && model !== processModel) {
    throw new StaleWorkerError(processModel, model);
  }
}
