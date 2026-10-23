import {
  readStoredSetting,
  retryTransaction,
  updateSettingLocked,
  type Database,
  type Transaction,
} from '@bantoozi/db';
import {
  EngineModelPinSchema,
  EngineModelResolutionSchema,
  MODEL_PROBE_MAX_AGE_MS,
  MODEL_PROBE_MAX_SKEW_MS,
  canonicalJson,
  type EngineModelPin,
  type EngineModelResolution,
} from '@bantoozi/shared';

export const MODEL_RESOLVE_TIMEOUT_MS = 30_000;
export const MODEL_RESOLVE_RETRY_MS = 300_000;

/** How this process knows the Jev model it serves (visible-learning §4.1). */
export type ModelState =
  | { kind: 'concrete'; model: string }
  | { kind: 'resolved'; alias: string; model: string; source: 'stored' | 'probed' }
  | { kind: 'unresolved'; alias: string; reason: string };

export interface ModelResolutionInput {
  alias: string;
  model: string;
  now: Date;
}

/**
 * Records what an alias resolved to in `engine.model_resolution` under the row lock. The same model
 * only moves `checkedAt`; another model moves the old one to `previous` and reports the change.
 * `onChange` runs in the same transaction, after the row is updated, when a concrete model was replaced.
 */
export async function recordModelResolution(
  db: Database,
  input: ModelResolutionInput,
  onChange?: (tx: Transaction, change: { from: string; to: string }) => Promise<void>,
): Promise<{ changed: boolean; previous?: string }> {
  const at = input.now.toISOString();
  const fresh = EngineModelResolutionSchema.parse({
    alias: input.alias,
    model: input.model,
    resolvedAt: at,
    checkedAt: at,
  });
  return retryTransaction(db, async (tx) => {
    let result: { changed: boolean; previous?: string } = { changed: true };
    await updateSettingLocked<EngineModelResolution | null>(
      tx,
      'engine.model_resolution',
      null,
      (current) => {
        const parsed = EngineModelResolutionSchema.safeParse(current);
        if (!parsed.success || parsed.data.alias !== fresh.alias) return fresh;
        const stored = parsed.data;
        if (stored.model === fresh.model) {
          result = { changed: false };
          return { ...stored, checkedAt: at };
        }
        result = { changed: true, previous: stored.model };
        return { ...fresh, previous: { model: stored.model, until: at } };
      },
    );
    if (onChange !== undefined && result.previous !== undefined) {
      await onChange(tx, { from: result.previous, to: fresh.model });
    }
    return result;
  });
}

/**
 * Whether a stored resolution still describes the model this installation serves. It is dormant
 * only when the pin is not alias-marked (no process ran the alias), names another model, and the
 * row was not confirmed within the probe window; every other row is in force. Not part of any
 * restart fingerprint: the fingerprint depends on stored rows only, never on the clock.
 */
export function resolutionInForce(
  row: EngineModelResolution,
  pin: EngineModelPin | null,
  now: number | Date,
): boolean {
  if (pin === null || pin.alias !== undefined || pin.model === row.model) return true;
  const age = (typeof now === 'number' ? now : now.getTime()) - Date.parse(row.checkedAt);
  return age >= -MODEL_PROBE_MAX_SKEW_MS && age <= MODEL_PROBE_MAX_AGE_MS;
}

/** The stored resolution and pin, each null when absent or invalid. */
export async function readResolutionState(
  db: Database,
): Promise<{ row: EngineModelResolution | null; pin: EngineModelPin | null }> {
  const row = EngineModelResolutionSchema.safeParse(
    await readStoredSetting(db, 'engine.model_resolution'),
  );
  const pin = EngineModelPinSchema.safeParse(await readStoredSetting(db, 'engine.model_pin'));
  return { row: row.success ? row.data : null, pin: pin.success ? pin.data : null };
}

/**
 * Records what the alias resolved to at a start or a retry, under the row lock, and returns the row
 * of record. A valid row for the alias is adopted untouched unless it is byte-equal to `dormant`
 * (the row the caller found dormant); otherwise a fresh row without `previous` is written. It never
 * produces a flip: a row in force is never replaced, and a dormant row was never in force.
 */
export async function recordStartResolution(
  db: Database,
  input: { alias: string; model: string; now: Date; dormant?: EngineModelResolution | undefined },
): Promise<EngineModelResolution> {
  const at = input.now.toISOString();
  const fresh = EngineModelResolutionSchema.parse({
    alias: input.alias,
    model: input.model,
    resolvedAt: at,
    checkedAt: at,
  });
  const dormant = input.dormant === undefined ? undefined : canonicalJson(input.dormant);
  return retryTransaction(db, async (tx) => {
    let record = fresh;
    await updateSettingLocked<EngineModelResolution | null>(
      tx,
      'engine.model_resolution',
      null,
      (current) => {
        const parsed = EngineModelResolutionSchema.safeParse(current);
        if (
          parsed.success &&
          parsed.data.alias === fresh.alias &&
          canonicalJson(parsed.data) !== dormant
        ) {
          record = parsed.data;
          return current as EngineModelResolution;
        }
        record = fresh;
        return fresh;
      },
    );
    return record;
  });
}
