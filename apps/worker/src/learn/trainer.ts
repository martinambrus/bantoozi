import {
  OUTER_MAX_K,
  trainUserModel,
  type FoldResult,
  type TrainArgs,
  type TrainResult,
} from '@bantoozi/ranker';

import { share, type CpuPool } from '../cpu-pool.js';

type TrainMode = 'production' | 'research';

/** Trains one model (spec 06 §8.3); the result is the same wherever it runs. */
export type Trainer = (args: TrainArgs, mode: TrainMode) => Promise<TrainResult>;

/** On the calling thread: tests, and tools that run nothing else meanwhile. */
export const inlineTrainer: Trainer = (args, mode) =>
  Promise.resolve(trainUserModel(args, { mode }));

/**
 * A trainer on the worker's CPU pool (D-262): the outer folds and the eligible-set hash run in
 * parallel on pool threads, then the finish on one, so neither the worker's event loop nor the transactions
 * other jobs hold open on it wait for a run (D-259). The folds are independent and are combined in
 * fold order, so the result equals {@link inlineTrainer}'s.
 */
export function poolTrainer(pool: CpuPool): Trainer {
  return async (input, mode) => {
    const args = share(input);
    // Every possible outer fold starts at once (a fold the plan lacks returns null), next to the
    // eligible-set hash; only the finish waits for them.
    const [setSha, ...folds] = await Promise.all([
      pool.run<string>({ kind: 'trainingSetSha', args }),
      ...Array.from({ length: OUTER_MAX_K }, (_, f) =>
        pool.run<FoldResult | null>({ kind: 'trainFold', args, mode, f }),
      ),
    ]);
    return pool.run<TrainResult>({
      kind: 'finishTraining',
      args,
      mode,
      folds: folds.filter((fold): fold is FoldResult => fold !== null),
      setSha: setSha as string,
    });
  };
}
