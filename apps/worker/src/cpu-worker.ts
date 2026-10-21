/**
 * A thread of the worker's CPU pool (D-262): runs CPU-bound tasks one at a time and posts each
 * result back, so the worker's event loop, and the transactions other jobs hold open on it, never
 * wait for them.
 */
import { parentPort } from 'node:worker_threads';

import type { CpuRequest, CpuResponse, CpuTask } from './cpu-pool.js';

// From sources (dev, tests) the thread registers tsx itself: Node 22.22 does not apply the
// parent's `--import` hooks to worker threads, and the sources import `.js` paths of `.ts` files.
// Every module with code is therefore imported after it (static imports would run first).
if (import.meta.url.endsWith('.ts')) {
  const { register } = await import('tsx/esm/api');
  register();
}
const { finishTraining, trainEstimateModel, trainFold, trainingSetSha } =
  await import('@bantoozi/ranker');
const { unshare } = await import('./cpu-pool.js');

function run(task: CpuTask): unknown {
  switch (task.kind) {
    case 'trainFold':
      return trainFold(unshare(task.args), { mode: task.mode }, task.f);
    case 'trainingSetSha':
      return trainingSetSha(unshare(task.args));
    case 'trainEstimate': {
      const args = unshare(task.args);
      return trainEstimateModel(args.samples, args.options);
    }
    case 'finishTraining':
      return finishTraining(unshare(task.args), { mode: task.mode }, task.folds, task.setSha);
  }
}

parentPort?.on('message', (request: CpuRequest) => {
  let response: CpuResponse;
  try {
    response = { id: request.id, ok: true, result: run(request.task) };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    response = { id: request.id, ok: false, error: { message: err.message, stack: err.stack } };
  }
  parentPort?.postMessage(response);
});
