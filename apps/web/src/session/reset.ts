/**
 * Why the account's local state is being dropped:
 * - `logout`: the user signed out (or deleted the account); everything private goes;
 * - `account_switch`: another account signed in on this device; everything of the old one goes;
 * - `unauthorized`: the session ended (401) and the same account may sign back in, so work queued
 *   offline is frozen rather than wiped (spec 09 §1);
 * - `remote`: another tab did one of the above and already dealt with persistent storage; only this
 *   tab's memory is left, and what its own writes stored once that tab began a removal.
 */
export type ResetReason = 'logout' | 'account_switch' | 'unauthorized' | 'remote';

export type ResetHook = (reason: ResetReason) => void | Promise<void>;

const hooks = new Set<ResetHook>();

/**
 * Registers a hook that runs whenever the account state is dropped, so stores outside the query
 * cache (the offline store) can drop theirs. Returns the function that unregisters it.
 */
export function onAccountReset(hook: ResetHook): () => void {
  hooks.add(hook);
  return () => {
    hooks.delete(hook);
  };
}

/** Runs every hook and waits for all; a hook that fails is reported and does not stop the rest. */
export async function runResetHooks(reason: ResetReason): Promise<void> {
  const outcomes = await Promise.allSettled([...hooks].map(async (hook) => hook(reason)));
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      console.error('An account reset hook failed', outcome.reason);
    }
  }
}
