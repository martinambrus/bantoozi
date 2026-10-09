import { useEffect } from 'react';

/** How long a tab waits before it asks again whether a new version has been published. */
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * A browser looks for a new service worker when a page loads, which a tab that stays open for days
 * never does. When such a tab comes back to the foreground with a connection, it asks the
 * registration, at most once an hour, counted from the registration or the last ask.
 */
export function useUpdateCheck(registration: ServiceWorkerRegistration | null): void {
  useEffect(() => {
    if (registration === null) return;
    let lastAsked = Date.now();
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) return;
      const now = Date.now();
      if (now - lastAsked < UPDATE_CHECK_INTERVAL_MS) return;
      lastAsked = now;
      // Offline, or the server is down: the next return after an hour asks again.
      registration.update().catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [registration]);
}
