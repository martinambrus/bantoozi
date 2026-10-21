import { retryTransaction, updateSettingLocked, type Database } from '@bantoozi/db';
import { EngineModelResolutionSchema, type EngineModelResolution } from '@bantoozi/shared';

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
 */
export async function recordModelResolution(
  db: Database,
  input: ModelResolutionInput,
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
    return result;
  });
}
