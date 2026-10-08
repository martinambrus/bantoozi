import type { UserPreferences } from '@bantoozi/shared';

export type ThemePreference = UserPreferences['theme'];
export type ResolvedTheme = 'light' | 'dark';

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemDark ? 'dark' : 'light';
  return preference;
}

/** `dark` switches Tailwind's dark variant; `color-scheme` darkens scrollbars and form controls. */
export function applyTheme(theme: ResolvedTheme, root: HTMLElement = document.documentElement) {
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
}

/** Where the preference is kept for public/theme.js, which paints the page before the app starts. */
export const THEME_STORAGE_KEY = 'bantoozi:theme';

function readStored(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'dark' || stored === 'light' ? stored : 'system';
  } catch {
    return 'system';
  }
}

function writeStored(preference: ThemePreference) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Without storage the page script follows the system until the app has started.
  }
}

// Starting from what the script painted keeps the first frame of the app from undoing it.
let current: ThemePreference = readStored();
const listeners = new Set<() => void>();

/** The chosen preference (the account's `theme` setting once it is loaded). */
export const themePreference = {
  get: (): ThemePreference => current,
  set(next: ThemePreference) {
    if (next === current) return;
    current = next;
    writeStored(next);
    for (const listener of [...listeners]) listener();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
