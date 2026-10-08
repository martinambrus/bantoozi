import { act, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyTheme, resolveTheme, themePreference } from '../../src/theme/theme.js';
import { ThemeSync } from '../../src/theme/theme-sync.js';

const DARK_QUERY = '(prefers-color-scheme: dark)';
const STORAGE_KEY = 'bantoozi:theme';
const root = document.documentElement;

describe('resolveTheme', () => {
  it.each([
    ['system', false, 'light'],
    ['system', true, 'dark'],
    ['light', false, 'light'],
    ['light', true, 'light'],
    ['dark', false, 'dark'],
    ['dark', true, 'dark'],
  ] as const)('%s preference, system dark=%s -> %s', (preference, systemDark, expected) => {
    expect(resolveTheme(preference, systemDark)).toBe(expected);
  });
});

describe('applyTheme', () => {
  it('toggles the dark class and the color scheme on the given root', () => {
    const element = document.createElement('div');
    applyTheme('dark', element);
    expect(element).toHaveClass('dark');
    expect(element.style.colorScheme).toBe('dark');

    applyTheme('light', element);
    expect(element).not.toHaveClass('dark');
    expect(element.style.colorScheme).toBe('light');
  });

  it('keeps other classes and is idempotent', () => {
    const element = document.createElement('div');
    element.className = 'keep';
    applyTheme('dark', element);
    applyTheme('dark', element);
    expect(element.className).toBe('keep dark');
  });

  it('defaults to the document element', () => {
    applyTheme('dark');
    expect(root).toHaveClass('dark');
    expect(root.style.colorScheme).toBe('dark');
    applyTheme('light');
    expect(root).not.toHaveClass('dark');
  });

  afterEach(() => {
    root.classList.remove('dark');
    root.style.colorScheme = '';
  });
});

describe('themePreference', () => {
  afterEach(() => {
    themePreference.set('system');
  });

  it('starts as system', () => {
    expect(themePreference.get()).toBe('system');
  });

  it('notifies subscribers of changes only, until they unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = themePreference.subscribe(listener);
    themePreference.set('dark');
    expect(themePreference.get()).toBe('dark');
    expect(listener).toHaveBeenCalledTimes(1);

    themePreference.set('dark');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    themePreference.set('light');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(themePreference.get()).toBe('light');
  });
});

describe('themePreference in the browser storage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    themePreference.set('system');
    localStorage.clear();
  });

  it('writes each chosen preference where the page script reads it', () => {
    themePreference.set('dark');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');
    themePreference.set('light');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('light');
    themePreference.set('system');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('system');
  });

  it('writes a preference once, and not again while it stays the current one', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem');
    themePreference.set('dark');
    themePreference.set('dark');
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(STORAGE_KEY, 'dark');
  });

  it('still changes the preference, and tells its subscribers, when the storage refuses the write', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const listener = vi.fn();
    themePreference.subscribe(listener);
    expect(() => themePreference.set('dark')).not.toThrow();
    expect(write).toHaveBeenCalledWith(STORAGE_KEY, 'dark');
    expect(themePreference.get()).toBe('dark');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('still changes the preference when merely reaching for the storage throws', () => {
    const reach = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(() => themePreference.set('dark')).not.toThrow();
    expect(reach).toHaveBeenCalled();
    expect(themePreference.get()).toBe('dark');
  });
});

describe('the preference when the app starts', () => {
  const realMatchMedia = window.matchMedia;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    window.matchMedia = realMatchMedia;
    localStorage.clear();
    root.classList.remove('dark');
    root.style.colorScheme = '';
  });

  async function startFresh() {
    vi.resetModules();
    return {
      theme: await import('../../src/theme/theme.js'),
      sync: await import('../../src/theme/theme-sync.js'),
    };
  }

  it.each(['dark', 'light', 'system'] as const)('is the stored %s', async (stored) => {
    localStorage.setItem(STORAGE_KEY, stored);
    const read = vi.spyOn(Storage.prototype, 'getItem');
    const { theme } = await startFresh();
    expect(read).toHaveBeenCalledWith(STORAGE_KEY);
    expect(theme.themePreference.get()).toBe(stored);
  });

  it.each([[null], ['sepia'], ['']] as const)(
    'is the system choice for a stored %j',
    async (stored) => {
      if (stored !== null) localStorage.setItem(STORAGE_KEY, stored);
      const read = vi.spyOn(Storage.prototype, 'getItem');
      const { theme } = await startFresh();
      expect(read).toHaveBeenCalledWith(STORAGE_KEY);
      expect(theme.themePreference.get()).toBe('system');
    },
  );

  it('is the system choice when the storage cannot be read', async () => {
    localStorage.setItem(STORAGE_KEY, 'dark');
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    const { theme } = await startFresh();
    expect(read).toHaveBeenCalledWith(STORAGE_KEY);
    expect(theme.themePreference.get()).toBe('system');
  });

  it('is kept by ThemeSync, so the dark page the script painted does not turn light', async () => {
    localStorage.setItem(STORAGE_KEY, 'dark');
    window.matchMedia = vi.fn(() => ({
      matches: false,
      media: DARK_QUERY,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    root.classList.add('dark');
    const { sync } = await startFresh();

    render(createElement(sync.ThemeSync));

    expect(root).toHaveClass('dark');
    expect(root.style.colorScheme).toBe('dark');
  });
});

describe('ThemeSync', () => {
  const realMatchMedia = window.matchMedia;

  /** A controllable `prefers-color-scheme: dark` query. */
  function stubSystemTheme(initiallyDark: boolean) {
    type Listener = (event: { matches: boolean; media: string }) => void;
    const listeners = new Set<Listener>();
    const query = {
      matches: initiallyDark,
      media: DARK_QUERY,
      onchange: null,
      addEventListener: (type: string, listener: Listener) => {
        if (type === 'change') listeners.add(listener);
      },
      removeEventListener: (type: string, listener: Listener) => {
        if (type === 'change') listeners.delete(listener);
      },
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    };
    const matchMedia = vi.fn((_media: string) => query);
    window.matchMedia = matchMedia as unknown as typeof window.matchMedia;
    return {
      matchMedia,
      listenerCount: () => listeners.size,
      change(matches: boolean) {
        query.matches = matches;
        act(() => {
          for (const listener of [...listeners]) listener({ matches, media: DARK_QUERY });
        });
      },
    };
  }

  beforeEach(() => {
    themePreference.set('system');
  });

  afterEach(() => {
    window.matchMedia = realMatchMedia;
    themePreference.set('system');
    root.classList.remove('dark');
    root.style.colorScheme = '';
  });

  it('applies the resolved theme on mount', () => {
    const system = stubSystemTheme(true);
    render(createElement(ThemeSync));
    expect(system.matchMedia).toHaveBeenCalledWith(DARK_QUERY);
    expect(root).toHaveClass('dark');
    expect(root.style.colorScheme).toBe('dark');
  });

  it('follows a light system until it changes', () => {
    const system = stubSystemTheme(false);
    render(createElement(ThemeSync));
    expect(root).not.toHaveClass('dark');
    expect(root.style.colorScheme).toBe('light');

    system.change(true);
    expect(root).toHaveClass('dark');
    expect(root.style.colorScheme).toBe('dark');

    system.change(false);
    expect(root).not.toHaveClass('dark');
    expect(root.style.colorScheme).toBe('light');
  });

  it('follows changes of the preference store', () => {
    stubSystemTheme(false);
    render(createElement(ThemeSync));
    act(() => themePreference.set('dark'));
    expect(root).toHaveClass('dark');
    act(() => themePreference.set('light'));
    expect(root).not.toHaveClass('dark');
    expect(root.style.colorScheme).toBe('light');
    act(() => themePreference.set('system'));
    expect(root).not.toHaveClass('dark');
  });

  it('goes back to the system theme when the preference returns to system', () => {
    stubSystemTheme(true);
    render(createElement(ThemeSync));
    act(() => themePreference.set('light'));
    expect(root).not.toHaveClass('dark');
    act(() => themePreference.set('system'));
    expect(root).toHaveClass('dark');
  });

  it.each([
    ['light', true],
    ['dark', false],
  ] as const)('ignores system changes while the preference is %s', (preference, systemDark) => {
    const system = stubSystemTheme(!systemDark);
    themePreference.set(preference);
    render(createElement(ThemeSync));
    const expectDark = preference === 'dark';
    expect(root.classList.contains('dark')).toBe(expectDark);

    system.change(systemDark);
    expect(root.classList.contains('dark')).toBe(expectDark);
    expect(root.style.colorScheme).toBe(preference);
  });

  it('listens to the system only while the preference is system', () => {
    const system = stubSystemTheme(false);
    const { unmount } = render(createElement(ThemeSync));
    expect(system.listenerCount()).toBe(1);

    act(() => themePreference.set('dark'));
    expect(system.listenerCount()).toBe(0);
    act(() => themePreference.set('system'));
    expect(system.listenerCount()).toBe(1);

    unmount();
    expect(system.listenerCount()).toBe(0);
  });
});
