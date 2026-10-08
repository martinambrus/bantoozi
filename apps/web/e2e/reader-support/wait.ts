/**
 * Waiting that is not an arbitrary sleep. A claim that something does NOT happen (no model call, no
 * image request) has no state to poll for, so it is checked repeatedly over a window instead.
 */

/**
 * Runs `check` now and then every `everyMs` until `windowMs` has passed; the first check that
 * throws fails the caller. The check should be a claim that holds from the first moment on.
 */
export async function staysTrueFor(
  windowMs: number,
  check: () => Promise<void>,
  everyMs = 250,
): Promise<void> {
  const end = Date.now() + windowMs;
  for (;;) {
    await check();
    const left = end - Date.now();
    if (left <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(everyMs, left)));
  }
}
