import {
  readStoredSetting,
  shareLockSettings,
  shareLockStoredSetting,
  type Executor,
} from '@bantoozi/db';
import { STALE_WORKER_RETRY_DELAY_SECONDS } from '@bantoozi/shared';

import type { ClassificationDeps } from './handlers/deps.js';

/**
 * A worker whose process values are not the current ones (M8b-T5, PR #28 round 4): a restart-class
 * setting or the model pin moved, so this process, which has not restarted yet, must neither ask its
 * old model nor write its answers. The job fails and the queue retries it after `retryDelaySeconds`
 * (the `retryDelay` of every queue in `STALE_GUARDED_QUEUES`), by when a drained worker has
 * restarted. `analysis.process` does not throw: it reschedules the request itself.
 */
export class StaleWorkerError extends Error {
  readonly retryDelaySeconds = STALE_WORKER_RETRY_DELAY_SECONDS;

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

/** The stored keys behind {@link import('./runtime.js').restartFingerprint}: a change needs a restart. */
export const RESTART_SETTING_KEYS = [
  'engine.typesafe_model',
  'engine.typesafe_base_url',
  'engine.llm_fallback_enabled',
  'engine.ollama_models',
  'engine.ollama_base_url',
  'engine.ollama_max_concurrency',
  'translate.libretranslate_url',
] as const;

/**
 * The non-throwing core of {@link assertWorkerCurrent}: the error describing why this process is not
 * what the database now asks for, or null while it is current.
 */
export async function workerStaleness(
  db: Executor,
  classification: Pick<ClassificationDeps, 'primaryModel' | 'currentness'>,
): Promise<StaleWorkerError | null> {
  const processModel = classification.primaryModel;
  const currentness = classification.currentness;
  if (
    currentness !== undefined &&
    (await currentness.restartFingerprint(db)) !== currentness.fingerprint
  ) {
    return new StaleWorkerError(processModel, processModel, 'restart_settings');
  }
  const stored = await readStoredSetting(db, 'engine.model_pin');
  if (stored === undefined || stored === null) return null;
  const pin = stored as { model?: unknown; llm?: PinLlm };
  if (typeof pin.model === 'string' && pin.model !== '' && pin.model !== processModel) {
    return new StaleWorkerError(processModel, pin.model);
  }
  if (currentness !== undefined && llmKey(pin.llm) !== llmKey(currentness.pin.llm)) {
    return new StaleWorkerError(processModel, processModel, 'restart_settings');
  }
  return null;
}

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
  const error = await workerStaleness(db, classification);
  if (error !== null) throw error;
}

/**
 * The same check inside a completion transaction (PR #28 round 5): the restart-class rows and the
 * pin row are share-locked first (a missing runtime row is stored as `null`, which reads as the
 * environment value, so nothing changes), so what is compared stays current until commit and a
 * writer waits for this transaction. Returns the error for the caller to discard its answer and
 * release what it holds, then throw it after the commit; null when this process is still current.
 */
export async function lockWorkerCurrent(
  tx: Executor,
  classification: Pick<ClassificationDeps, 'primaryModel' | 'currentness'>,
): Promise<StaleWorkerError | null> {
  await shareLockSettings(
    tx,
    RESTART_SETTING_KEYS.map((key) => ({ key, initial: null })),
  );
  await shareLockStoredSetting(tx, 'engine.model_pin');
  await shareLockStoredSetting(tx, 'engine.model_resolution');
  return workerStaleness(tx, classification);
}

/**
 * Whether this process's restart-class view is still the current one, for a pin write. Only the
 * restart keys are share-locked (an admin save waits for the transaction); the pin row is taken
 * `FOR UPDATE` afterwards and the resolution row is only read, per the lock order restart keys <
 * pin < resolution < watch.
 */
export async function lockRestartCurrent(
  tx: Executor,
  classification: Pick<ClassificationDeps, 'currentness'>,
): Promise<boolean> {
  await shareLockSettings(
    tx,
    RESTART_SETTING_KEYS.map((key) => ({ key, initial: null })),
  );
  const currentness = classification.currentness;
  return currentness === undefined
    ? true
    : (await currentness.restartFingerprint(tx)) === currentness.fingerprint;
}
