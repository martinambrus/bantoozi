import {
  trainEstimateModel,
  type EstimateOptions,
  type EstimateSample,
  type EstimateTrainResult,
} from '@bantoozi/ranker';

import { share, type CpuPool } from '../cpu-pool.js';

/** Trains one reader's word model (visible-learning §4.4); the result is the same wherever it runs. */
export type EstimateTrainer = (
  samples: readonly EstimateSample[],
  options: Partial<EstimateOptions>,
) => Promise<EstimateTrainResult>;

/** On the calling thread: tests, and tools that run nothing else meanwhile. */
export const inlineEstimateTrainer: EstimateTrainer = (samples, options) =>
  Promise.resolve(trainEstimateModel(samples, options));

/**
 * A trainer on the worker's CPU pool (D-262): the event loop is blocked for about 12 ms instead of
 * 335 ms for 5,000 ratings. The result equals {@link inlineEstimateTrainer}'s.
 */
export function poolEstimateTrainer(pool: CpuPool): EstimateTrainer {
  return (samples, options) =>
    pool.run({ kind: 'trainEstimate', args: share({ samples: [...samples], options }) });
}
