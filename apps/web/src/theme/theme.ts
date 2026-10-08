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

let current: ThemePreference = 'system';
const listeners = new Set<() => void>();

/** The chosen preference (the account's `theme` setting once it is loaded). */
export const themePreference = {
  get: (): ThemePreference => current,
  set(next: ThemePreference) {
    if (next === current) return;
    current = next;
    for (const listener of [...listeners]) listener();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
