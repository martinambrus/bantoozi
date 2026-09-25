import { AppError } from '../errors.js';
import { compareBigIntStrings, nextRevision } from '../ids.js';

/**
 * Per-subscription inference policy (specs 02 §3.4, 03 §1.1, 08 §4.1; PLAN §2 decision 9, Q11).
 * `off` (default) creates no inference demand; `training` admits only explicitly selected articles;
 * `active` admits automatic inference for carrier arrivals at/after the activation time.
 */
export const INFERENCE_MODES = ['off', 'training', 'active'] as const;
export type InferenceMode = (typeof INFERENCE_MODES)[number];

export interface SubscriptionInferenceState {
  mode: InferenceMode;
  /** Decimal bigint string, incremented by every mode change. */
  version: string;
  /** Set only while active: the activation transaction time. */
  activatedAt: Date | null;
}

export type InferenceModeChange =
  | { kind: 'noop'; state: SubscriptionInferenceState }
  | { kind: 'change'; state: SubscriptionInferenceState; from: InferenceMode };

/**
 * Plan a mode change under the subscription row lock. The client's expected version must match
 * (CAS); reapplying the same mode is an idempotent no-op. A change increments the version and sets
 * `activatedAt` to `now` only when entering active (null when leaving).
 */
export function planInferenceModeChange(
  current: SubscriptionInferenceState,
  requested: InferenceMode,
  expectedVersion: string,
  now: Date,
): InferenceModeChange {
  if (compareBigIntStrings(current.version, expectedVersion) !== 0) {
    throw new AppError('STALE_STATE', 'Subscription inference version changed', {
      details: { currentVersion: current.version },
    });
  }
  if (current.mode === requested) return { kind: 'noop', state: current };
  return {
    kind: 'change',
    from: current.mode,
    state: {
      mode: requested,
      version: nextRevision(current.version),
      activatedAt: requested === 'active' ? now : null,
    },
  };
}

/** Database invariant `(inference_mode = 'active') = (inference_activated_at IS NOT NULL)`. */
export function isValidInferenceState(state: SubscriptionInferenceState): boolean {
  return (state.mode === 'active') === (state.activatedAt !== null);
}

/**
 * Automatic demand for one carrier: the witness subscription is still active at the witnessed
 * version and this carrier's `feed_items.first_seen_at` is at/after `inference_activated_at`.
 * Activation is prospective; it never authorizes a historical backfill.
 */
export function admitsAutomaticInference(
  subscription: SubscriptionInferenceState,
  carrierFirstSeenAt: Date,
  witnessVersion?: string,
): boolean {
  if (subscription.mode !== 'active' || subscription.activatedAt === null) return false;
  if (
    witnessVersion !== undefined &&
    compareBigIntStrings(subscription.version, witnessVersion) !== 0
  ) {
    return false;
  }
  return carrierFirstSeenAt.getTime() >= subscription.activatedAt.getTime();
}

/**
 * Selected-article analysis (spec 08 §4.1): allowed in training/active. From `off` it requires the
 * explicit combined `startTraining: true` consent, which moves the subscription to `training`.
 */
export function analysisRequestTransition(
  mode: InferenceMode,
  startTraining: boolean,
): { allowed: true; enterTraining: boolean } | { allowed: false } {
  if (mode === 'off')
    return startTraining ? { allowed: true, enterTraining: true } : { allowed: false };
  return { allowed: true, enterTraining: false };
}
