import { useCallback, useState } from 'react';

/** Whether this device shows the reader's sidebar as a narrow strip of icons (D-235). */
export const SIDEBAR_COLLAPSED_KEY = 'bantoozi:sidebar-collapsed';

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * The collapsed sidebar of a wide screen. It is a choice of the device, not of the account, so it
 * is kept in the browser; a browser that keeps nothing starts with the full sidebar.
 */
export function useSidebarCollapsed(): [boolean, (collapsed: boolean) => void] {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const change = useCallback((next: boolean) => {
    setCollapsed(next);
    try {
      if (next) window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, '1');
      else window.localStorage.removeItem(SIDEBAR_COLLAPSED_KEY);
    } catch {
      // The choice then lasts until the page is left.
    }
  }, []);
  return [collapsed, change];
}
