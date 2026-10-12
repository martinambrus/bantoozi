import { vi } from 'vitest';

/**
 * Makes a housekeeping handler's run budget expire after `pages` unit(s) of work: the handler
 * reads `Date.now()` once to start and once before each page, so from the (pages + 2)th read made
 * by a function in a file whose path contains `fileFragment` the clock is 6 minutes ahead (the
 * budget is 5). Reads from anywhere else (drivers, loggers) see the real clock. Call the returned
 * function to restore the clock.
 */
export function cutBudgetAfterPages(fileFragment: string, pages: number): () => void {
  const real = Date.now.bind(Date);
  let reads = 0;
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => {
    const caller =
      (new Error().stack ?? '')
        .split('\n')
        .slice(1)
        .find((line) => !line.includes('budget.ts') && !line.includes('/chunks/spy.')) ?? '';
    if (!caller.includes(fileFragment)) return real();
    reads += 1;
    return reads >= pages + 2 ? real() + 6 * 60_000 : real();
  });
  return () => spy.mockRestore();
}
