import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, vi, type MockInstance } from 'vitest';

const REACT_WARNING =
  /\bact\(|Cannot update (?:a component|during an existing state transition)|Too many re-renders|Maximum update depth exceeded/i;

/** Fail this file's tests on React act or render-time updates, including warnings React catches. */
export function failOnReactWarnings() {
  let error: MockInstance<typeof console.error>;
  let warnings: string[];

  beforeEach(() => {
    warnings = [];
    const original = console.error;
    error = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      const message = args.map(String).join(' ');
      if (REACT_WARNING.test(message)) {
        warnings.push(message);
        throw new Error(message);
      }
      original(...args);
    });
  });

  afterEach(() => {
    try {
      // Keep the spy active through unmount, even if another hook also cleans up or restores mocks.
      cleanup();
      expect(warnings, 'React act or render-time warnings').toEqual([]);
    } finally {
      error.mockRestore();
    }
  });
}
