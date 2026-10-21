import { countEstimateRatings, loadEstimateModel, type Executor } from '@bantoozi/db';
import {
  activeEstimate,
  ESTIMATE_SPEC,
  estimateGate,
  parseEstimateModel,
  type ActiveEstimate,
  type EstimateModel,
} from '@bantoozi/ranker';
import type { UserPreferences } from '@bantoozi/shared';

/** The reader's word-estimate model as one rank run finds it (visible-learning §4.4). */
export type RankEstimateState =
  /** `prefs.estimates` is not `on`: nothing was loaded. */
  | { status: 'off' }
  /** No model is stored; `backfill` when the reader's ratings open the gate, so a training is due. */
  | { status: 'none'; backfill: boolean }
  /** The stored model is of another `ESTIMATE_SPEC` or does not parse: a retraining is due. */
  | { status: 'stale' }
  | { status: 'current'; version: number; model: EstimateModel };

/**
 * Loads the newest stored model for the run. `since` is the start of the training window
 * (`model.historyDays`) and `gate` the `RankerConfig.estimate` thresholds, used only to decide
 * `backfill` with the cheap rating count.
 */
export async function loadRankEstimateState(
  db: Executor,
  input: {
    userId: string;
    preferences: UserPreferences;
    since: Date;
    gate: { minRatings: number; minEachClass: number };
  },
): Promise<RankEstimateState> {
  if (input.preferences.estimates !== 'on') return { status: 'off' };
  const row = await loadEstimateModel(db, input.userId);
  if (row === null) {
    const counts = await countEstimateRatings(db, input.userId, input.since);
    return { status: 'none', backfill: estimateGate(counts, input.gate).open };
  }
  const model = row.spec === ESTIMATE_SPEC ? parseEstimateModel(row) : null;
  return model === null ? { status: 'stale' } : { status: 'current', version: row.version, model };
}

/** The context's `estimate` for a current state; undefined for every other status. */
export function buildActiveEstimate(state: RankEstimateState): ActiveEstimate | undefined {
  if (state.status !== 'current') return undefined;
  return activeEstimate({ version: state.version, model: state.model }) ?? undefined;
}
