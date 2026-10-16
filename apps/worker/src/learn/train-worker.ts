/**
 * The `user.learn` training thread (D-259): trains one model from `workerData` and posts the
 * result, so the worker's event loop, and the transactions other jobs hold open on it, never wait
 * for a training run.
 */
import { parentPort, workerData } from 'node:worker_threads';

import { trainUserModel } from '@bantoozi/ranker';

import type { TrainWorkerData } from './train-thread.js';

const data = workerData as TrainWorkerData;
parentPort?.postMessage(trainUserModel(data.args, { mode: data.mode }));
