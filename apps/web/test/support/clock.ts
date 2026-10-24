import { vi } from 'vitest';

/** Move browser deadlines by hand; leave IndexedDB's setImmediate scheduler running. */
export function useFakeClock(): void {
  const now = Date.now();
  // A parent describe may already fake Date only; reinstall to include the browser timers.
  vi.useRealTimers();
  vi.useFakeTimers({
    now,
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
}
