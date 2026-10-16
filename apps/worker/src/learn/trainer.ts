import { Worker } from 'node:worker_threads';

import { trainUserModel, type TrainResult } from '@bantoozi/ranker';

type TrainArgs = Parameters<typeof trainUserModel>[0];
type TrainMode = Parameters<typeof trainUserModel>[1]['mode'];

export interface TrainWorkerData {
  args: TrainArgs;
  mode: TrainMode;
}

/** Trains one model (spec 06 §8.3); the result is the same wherever it runs. */
export type Trainer = (args: TrainArgs, mode: TrainMode) => Promise<TrainResult>;

/** On the calling thread: tests, and tools that run nothing else meanwhile. */
export const inlineTrainer: Trainer = (args, mode) =>
  Promise.resolve(trainUserModel(args, { mode }));

/**
 * The thread module next to this one: `.ts` when running from sources (the thread inherits the
 * parent's loader and conditions through `execArgv`), `.js` in the compiled app.
 */
const WORKER_URL = new URL(
  `./train-worker.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`,
  import.meta.url,
);

/**
 * A trainer that runs every training in a thread of its own (D-259): training a few thousand
 * samples is tens of seconds of CPU, during which the worker's event loop would stop every other
 * job, including transactions they hold open on the user's row. Inputs and results are plain data
 * (structured clone keeps their dates).
 */
export function threadTrainer(options: { execArgv?: string[] } = {}): Trainer {
  return (args, mode) =>
    new Promise<TrainResult>((resolve, reject) => {
      const workerData: TrainWorkerData = { args, mode };
      const worker = new Worker(WORKER_URL, {
        workerData,
        name: 'bantoozi-user-learn',
        ...(options.execArgv === undefined ? {} : { execArgv: options.execArgv }),
      });
      let settled = false;
      worker.once('message', (result: TrainResult) => {
        settled = true;
        resolve(result);
        void worker.terminate();
      });
      worker.once('error', (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      });
      worker.once('exit', (code: number) => {
        if (settled) return;
        settled = true;
        reject(new Error(`The training thread exited with code ${code} without a result`));
      });
    });
}
