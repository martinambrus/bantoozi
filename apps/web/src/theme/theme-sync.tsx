import { useLayoutEffect, useSyncExternalStore } from 'react';

import { applyTheme, resolveTheme, themePreference } from './theme.js';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Keeps the document's theme in line with the preference and, while it is `system`, with the OS. */
export function ThemeSync() {
  const preference = useSyncExternalStore(
    themePreference.subscribe,
    themePreference.get,
    themePreference.get,
  );

  // A layout effect, so a dark system never gets a frame of the light theme.
  useLayoutEffect(() => {
    if (preference !== 'system') {
      applyTheme(resolveTheme(preference, false));
      return;
    }
    const query = window.matchMedia(DARK_QUERY);
    applyTheme(resolveTheme('system', query.matches));
    function onChange(event: { matches: boolean }) {
      applyTheme(resolveTheme('system', event.matches));
    }
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [preference]);

  return null;
}
