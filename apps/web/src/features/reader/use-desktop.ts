import { useSyncExternalStore } from 'react';

const DESKTOP_QUERY = '(min-width: 1024px)';

function subscribe(listener: () => void) {
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}

/** Whether the screen is wide enough for the sidebar and the detail pane (spec 09 §3.1). */
export function useDesktop(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => false,
  );
}
