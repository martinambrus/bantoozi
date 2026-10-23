import {
  retryTransaction,
  updateSettingLocked,
  workerOutbox,
  type Database,
  type Transaction,
} from '@bantoozi/db';
import { buildJobIntent, parseSetting } from '@bantoozi/shared';

/** The pin a worker derives from its config: `llm` exists only while the fallback is on. */
export interface WorkerModelPin {
  model: string;
  alias?: string | undefined;
  llm?: { fast: string; strong: string } | undefined;
}

const llmKey = (llm: WorkerModelPin['llm']): string | null =>
  llm ? `${llm.fast}\u0000${llm.strong}` : null;

/**
 * Worker start (spec 11 §8): records the configured pin in `engine.model_pin` under the row lock,
 * so a suggestion finishing transaction holding the row `FOR SHARE` is fenced. A changed model or
 * fallback state advances `since` and enqueues `house.reenrich` and `house.rematch` once (the
 * pin's `since` is the intent revision, so a later change is not coalesced with a pending one) through
 * the outbox in the same transaction; a missing row is inserted without an enqueue. Other stored
 * keys (`laya`) are kept. `options.isCurrent` is a compare-and-set against the process's own view:
 * when it answers false inside the transaction nothing is written or enqueued (`skipped`).
 */
export async function recordModelPin(
  db: Database,
  pin: WorkerModelPin,
  now: Date,
  options: { isCurrent?: (tx: Transaction) => Promise<boolean> } = {},
): Promise<{ changed: boolean; skipped?: true }> {
  const since = now.toISOString();
  const fresh = parseSetting('engine.model_pin', {
    model: pin.model,
    ...(pin.alias ? { alias: pin.alias } : {}),
    ...(pin.llm ? { llm: pin.llm } : {}),
    since,
  });
  return retryTransaction(db, async (tx): Promise<{ changed: boolean; skipped?: true }> => {
    if (options.isCurrent !== undefined && !(await options.isCurrent(tx))) {
      return { changed: false, skipped: true };
    }
    let changed = false;
    await updateSettingLocked(tx, 'engine.model_pin', fresh, (current) => {
      if (current === undefined || current === null) return fresh;
      const stored = parseSetting('engine.model_pin', current);
      if (stored === undefined) return fresh;
      const { alias: _storedAlias, ...withoutAlias } = stored;
      if (stored.model === pin.model && llmKey(stored.llm) === llmKey(pin.llm)) {
        return { ...withoutAlias, ...(pin.alias ? { alias: pin.alias } : {}) } as typeof stored;
      }
      changed = true;
      const { llm: _llm, ...kept } = withoutAlias;
      return {
        ...kept,
        model: pin.model,
        ...(pin.alias ? { alias: pin.alias } : {}),
        ...(pin.llm ? { llm: pin.llm } : {}),
        since,
      };
    });
    if (changed) {
      const outbox = workerOutbox(tx);
      await outbox.enqueue(buildJobIntent('house.reenrich', {}, { revision: since }));
      await outbox.enqueue(buildJobIntent('house.rematch', {}, { revision: since }));
    }
    return { changed };
  });
}
