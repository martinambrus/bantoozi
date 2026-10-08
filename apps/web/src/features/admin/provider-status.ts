import type { CredentialStatus, Provider } from '@bantoozi/shared';

/** How often the credential list is read while a validation is running (spec 09 §8). */
export const VALIDATION_POLL_MS = 2000;
/** A queued validation that no worker has picked up is looked for this long, then left alone. */
const VALIDATION_WATCH_MS = 120_000;

export interface ValidationWatch {
  /** The credential as it was when Validate was requested. */
  snapshot: string;
  startedAt: number;
}

export type ValidationWatches = Partial<Record<Provider, ValidationWatch>>;

export function snapshotOf(credential: CredentialStatus): string {
  return [
    credential.revision,
    credential.candidateVersion,
    credential.candidateStatus,
    credential.validatedAt,
    credential.lastErrorCode,
  ].join('|');
}

/**
 * Whether the list should be read again: a validation is running, or Validate was requested and
 * the worker has not touched the credential yet. A result, even an inconclusive one that only sets
 * `lastErrorCode`, changes the snapshot and ends the wait.
 */
export function validationRunning(
  credentials: readonly CredentialStatus[] | undefined,
  watches: ValidationWatches,
  now: number,
): boolean {
  return (credentials ?? []).some((credential) => {
    if (credential.candidateStatus === 'validating') return true;
    const watch = watches[credential.provider];
    return (
      watch !== undefined &&
      now - watch.startedAt < VALIDATION_WATCH_MS &&
      snapshotOf(credential) === watch.snapshot
    );
  });
}

export const KNOWN_ERROR_CODES: readonly string[] = [
  'invalid_response',
  'rate_limited',
  'timeout',
  'provider_unavailable',
  'not_configured',
  'probe_budget_exceeded',
  'decrypt_failed',
  'budget_unavailable',
  'auth_rejected',
  'request_rejected',
  'provider_error',
  'cost_overrun',
  'credential_unavailable',
];
