// Stub parser worker: ignores noise messages and answers with a fixed result.
import { parentPort, workerData } from 'node:worker_threads';

parentPort?.postMessage('noise');
parentPort?.postMessage({ type: 'unknown' });
parentPort?.postMessage({ type: 'started' });
parentPort?.postMessage({
  type: 'done',
  output: { ok: false, code: 'XML_MALFORMED', message: `echo ${workerData.text}` },
});
