import { useEffect, useRef, useSyncExternalStore } from 'react';

import { useOnline } from '../../components/states/use-online.js';

/** Spec 09 §1: every 5 seconds while the server is working on something, else every 30. */
export const BUSY_POLL_MS = 5_000;
export const IDLE_POLL_MS = 30_000;

function subscribe(listener: () => void) {
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
}

function usePageVisible(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => document.visibilityState !== 'hidden',
    () => true,
  );
}

export interface PollingOptions {
  /** Whether the server is ranking or analysing something the reader is looking at. */
  busy: boolean;
  refreshList: () => void;
  refreshCounts: () => void;
}

/**
 * Asks for the counts every 5 seconds while `busy`, else every 30, and for the list every 5 seconds
 * while `busy` and never otherwise, so that an idle list does not move under the reader (spec 09
 * §1). Nothing is asked while the page is hidden or the browser is offline.
 */
export function usePolling({ busy, refreshList, refreshCounts }: PollingOptions): void {
  const online = useOnline();
  const visible = usePageVisible();
  const active = online && visible;
  const latest = useRef({ refreshList, refreshCounts });

  useEffect(() => {
    latest.current = { refreshList, refreshCounts };
  });

  useEffect(() => {
    if (!active) return;
    const timers = [
      setInterval(() => latest.current.refreshCounts(), busy ? BUSY_POLL_MS : IDLE_POLL_MS),
    ];
    if (busy) timers.push(setInterval(() => latest.current.refreshList(), BUSY_POLL_MS));
    return () => {
      for (const timer of timers) clearInterval(timer);
    };
  }, [active, busy]);
}
