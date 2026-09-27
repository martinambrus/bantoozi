import { readStoredSetting, type Executor } from '@bantoozi/db';
import type { EngineRouter } from '@bantoozi/engine';
import { readSetting, type SettingEnvDefaults } from '@bantoozi/shared';

/**
 * Whether the primary engine can serve recovery work now (spec 04 §5): the breaker **mirror**
 * `settings['engine.circuit']` (the authoritative shared state, not a process-local copy) shows Jev
 * neither in `auth` mode nor open before its `openUntil`, an active Jev credential exists, and the
 * bulk budget still admits spend. Advisory only: every call still reserves and rechecks demand.
 */
export type PrimaryAvailability =
  { available: true } | { available: false; reason: 'auth' | 'circuit_open' | 'no_key' | 'budget' };

export async function primaryAvailability(
  db: Executor,
  router: EngineRouter,
  env: SettingEnvDefaults,
  now: Date,
): Promise<PrimaryAvailability> {
  const circuit = readSetting('engine.circuit', await readStoredSetting(db, 'engine.circuit'), env);
  const breaker = circuit?.typesafe;
  if (breaker?.state === 'auth') return { available: false, reason: 'auth' };
  if (
    breaker?.state === 'open' &&
    (breaker.openUntil === undefined || new Date(breaker.openUntil).getTime() > now.getTime())
  ) {
    return { available: false, reason: 'circuit_open' };
  }
  const status = await router.status();
  const credential = status.credentials.typesafe;
  if (credential.source === 'none' || !credential.enabled) {
    return { available: false, reason: 'no_key' };
  }
  if (!(await router.canSpend(0, 'bulk'))) return { available: false, reason: 'budget' };
  return { available: true };
}
