/** Both worker containers allow 120 seconds; leave five seconds before Docker's hard kill. */
export const WORKER_SHUTDOWN_TIMEOUT_MS = 115_000;

/** Bound the complete shutdown, including a self-restart that has no Docker SIGTERM deadline. */
export async function withShutdownDeadline(
  shutdown: () => Promise<void>,
  exit: () => void,
  timeoutMs = WORKER_SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      exit();
      reject(new Error('worker shutdown deadline exceeded'));
    }, timeoutMs);
    timer.unref();
  });
  try {
    await Promise.race([shutdown(), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
