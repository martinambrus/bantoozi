import {
  loadEstimateRatings,
  loadEstimateState,
  type EstimateRating,
  type EstimateStateRow,
  type Executor,
} from '@bantoozi/db';
import {
  DEFAULT_ESTIMATE_OPTIONS,
  ESTIMATE_SPEC,
  estimateGate,
  estimateInputSha,
  type EstimateOptions,
  type RankerSettings,
} from '@bantoozi/ranker';

const DAY_MS = 86_400_000;

/** Everything `user.estimate` decides on: the window's ratings, the trainer options and the stored state. */
export interface EstimateInputs {
  ratings: EstimateRating[];
  options: EstimateOptions;
  inputSha: string;
  state: EstimateStateRow | null;
  counts: { n: number; nPos: number; nNeg: number };
}

/**
 * Loads the inputs of a reader's word model as of `now`: the explicit ratings of the last
 * `model.historyDays`, the options derived from the ranker settings, their hash and the newest stored
 * model state. Shared by `user.estimate` and the nightly sweep so both judge staleness identically.
 */
export async function loadEstimateInputs(
  db: Executor,
  userId: string,
  config: RankerSettings['config'],
  now: Date,
): Promise<EstimateInputs> {
  const options: EstimateOptions = {
    ...DEFAULT_ESTIMATE_OPTIONS,
    minRatings: config.estimate.minRatings,
    minEachClass: config.estimate.minEachClass,
  };
  const since = new Date(now.getTime() - config.model.historyDays * DAY_MS);
  const ratings = await loadEstimateRatings(db, userId, since);
  const inputSha = estimateInputSha(ratings, options);
  const state = await loadEstimateState(db, userId);
  const nPos = ratings.filter((r) => r.rating === 1).length;
  return {
    ratings,
    options,
    inputSha,
    state,
    counts: { n: ratings.length, nPos, nNeg: ratings.length - nPos },
  };
}

/**
 * What `user.estimate` does with these inputs: `unchanged` (a model of the current spec with the same
 * input hash), `idle` (gate closed, nothing stored), `delete` (gate closed, a model stored), `train`.
 */
export function estimateAction(inputs: EstimateInputs): 'unchanged' | 'idle' | 'delete' | 'train' {
  const { state, inputSha, counts, options } = inputs;
  if (state !== null && state.spec === ESTIMATE_SPEC && state.metrics['inputSha'] === inputSha) {
    return 'unchanged';
  }
  if (!estimateGate(counts, options).open) return state === null ? 'idle' : 'delete';
  return 'train';
}
