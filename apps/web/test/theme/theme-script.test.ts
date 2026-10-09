import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const scripts = import.meta.glob<string>('../../public/theme.js', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const source = Object.values(scripts).join('\n');

const KEY = 'bantoozi:theme';
const root = document.documentElement;
const realMatchMedia = window.matchMedia;

function systemDark(dark: boolean) {
  window.matchMedia = vi.fn((media: string) => ({
    matches: dark,
    media,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** Runs the file the way the browser does: a classic script, before anything else. */
function runThemeScript() {
  new Function(source)();
}

beforeEach(() => {
  localStorage.clear();
  systemDark(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  window.matchMedia = realMatchMedia;
  localStorage.clear();
  root.classList.remove('dark');
  root.style.colorScheme = '';
});

describe('public/theme.js', () => {
  it('is one classic script, not a module', () => {
    expect(Object.keys(scripts)).toEqual(['../../public/theme.js']);
    expect(source).not.toMatch(/^\s*(import|export)\s/m);
  });

  it.each([
    ['dark', false, true],
    ['dark', true, true],
    ['light', false, false],
    ['light', true, false],
    ['system', false, false],
    ['system', true, true],
  ] as const)(
    'a stored %s with a dark system of %s makes the page dark: %s',
    (stored, system, expected) => {
      localStorage.setItem(KEY, stored);
      systemDark(system);
      runThemeScript();
      expect(root.classList.contains('dark')).toBe(expected);
      expect(root.style.colorScheme).toBe(expected ? 'dark' : 'light');
    },
  );

  it.each([
    [true, true],
    [false, false],
  ] as const)('follows the system when nothing is stored (dark system: %s)', (system, expected) => {
    systemDark(system);
    runThemeScript();
    expect(root.classList.contains('dark')).toBe(expected);
    expect(root.style.colorScheme).toBe(expected ? 'dark' : 'light');
  });

  it('reads a value it does not know as the system choice', () => {
    localStorage.setItem(KEY, 'sepia');
    systemDark(true);
    runThemeScript();
    expect(root).toHaveClass('dark');
  });

  it('takes a dark class away again for a stored light preference', () => {
    root.classList.add('dark');
    localStorage.setItem(KEY, 'light');
    systemDark(true);
    runThemeScript();
    expect(root).not.toHaveClass('dark');
  });

  it('changes nothing, and throws nothing, when the storage cannot be read', () => {
    systemDark(true);
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(runThemeScript).not.toThrow();
    expect(read).toHaveBeenCalledWith(KEY);
    expect(root).not.toHaveClass('dark');
    expect(root.style.colorScheme).toBe('');
  });

  it('changes nothing when merely reaching for the storage throws', () => {
    systemDark(true);
    const reach = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(runThemeScript).not.toThrow();
    expect(reach).toHaveBeenCalled();
    expect(root).not.toHaveClass('dark');
    expect(root.style.colorScheme).toBe('');
  });
});
