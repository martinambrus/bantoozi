// Stub parser worker: starts, then dies with an uncaught error (like an out-of-memory abort).
import { parentPort } from 'node:worker_threads';

parentPort?.postMessage({ type: 'started' });
throw new Error('stub worker crashed');
