import { Control } from './support/control.js';

const TIMEOUT_MS = 60_000;
const INTERVAL_MS = 500;

/** Waits until the worker has started and scheduled its crons: it has no HTTP listener of its own. */
export default async function globalSetup(): Promise<void> {
  const control = new Control();
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    let problem: string;
    try {
      if (await control.workerReady()) return;
      problem = 'the worker has not written its heartbeat and cron schedule yet';
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() >= deadline) {
      throw new Error(`the worker was not ready within ${TIMEOUT_MS / 1000} s: ${problem}`);
    }
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
}
