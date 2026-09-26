// Stub parser worker: starts, then exits without a result.
import { parentPort } from 'node:worker_threads';

parentPort?.postMessage({ type: 'started' });
process.exit(3);
