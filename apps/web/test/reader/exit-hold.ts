import { act } from '@testing-library/react';
import { onTestFinished } from 'vitest';

import { EXIT_MS } from '../../src/features/reader/article-list.js';

type Held = { id: number; run: () => void };

/**
 * Holds the list's exit timer (the only EXIT_MS one) so a slow machine cannot fire it between steps.
 * Plain assignments, not spies: Testing Library takes a mock `setTimeout` for fake timers.
 */
export function holdExits() {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  let queue: Held[] = [];
  let next = -1;
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay !== EXIT_MS || typeof handler !== 'function') {
      return realSet(handler, delay, ...args);
    }
    const id = next--;
    queue.push({ id, run: () => void handler(...args) });
    return id;
  }) as typeof setTimeout;
  // Keep Testing Library's fake-clock detection when exits are held over plain fake timers.
  if ('clock' in realSet) Object.assign(globalThis.setTimeout, { clock: realSet.clock });
  globalThis.clearTimeout = ((id?: number) => {
    if (typeof id === 'number' && queue.some((held) => held.id === id)) {
      queue = queue.filter((held) => held.id !== id);
      return;
    }
    realClear(id);
  }) as typeof clearTimeout;
  onTestFinished(() => {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  });
  return {
    held: () => queue.length,
    async release(): Promise<void> {
      const due = queue;
      queue = [];
      await act(async () => {
        for (const held of due) held.run();
      });
    },
  };
}
