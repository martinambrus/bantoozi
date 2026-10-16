/**
 * The `user.learn` training thread (D-259): trains one model from `workerData` and posts the
 * result, so the worker's event loop, and the transactions other jobs hold open on it, never wait
 * for a training run.
 */
import { parentPort, workerData } from 'node:worker_threads';

import type { TrainWorkerData } from './train-thread.js';

// From sources (dev, tests) the thread registers tsx itself: Node 22.22 does not apply the
// parent's `--import` hooks to worker threads, and the sources import `.js` paths of `.ts` files.
if (import.meta.url.endsWith('.ts')) {
  const { register } = await import('tsx/esm/api');
  register();
}
const { trainUserModel } = await import('@bantoozi/ranker');

const data = workerData as TrainWorkerData;
parentPort?.postMessage(trainUserModel(data.args, { mode: data.mode }));
