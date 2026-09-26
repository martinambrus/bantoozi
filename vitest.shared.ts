import { defaultClientConditions, defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Export condition that maps `@bantoozi/*` workspace packages to their TypeScript sources, so tests
 * and dev servers never depend on (possibly stale) `dist/` builds (spec 01 §6, build contract).
 */
export const SOURCE_CONDITION = 'bantoozi-source';

const resolveConfig = {
  resolve: { conditions: [SOURCE_CONDITION, ...defaultClientConditions] },
  ssr: { resolve: { conditions: [SOURCE_CONDITION, ...defaultServerConditions] } },
};

/** Unit tests: every `*.test.ts(x)` except integration/backend-e2e files and Playwright specs. */
export const UNIT_TEST_EXCLUDE = [
  '**/*.int.test.ts',
  '**/*.e2e.test.ts',
  'e2e/**',
  '**/node_modules/**',
  '**/dist/**',
];

export function unitTestConfig(options: { coverageLinesThreshold?: number } = {}) {
  const threshold = options.coverageLinesThreshold;
  return defineConfig({
    ...resolveConfig,
    test: {
      include: ['**/*.test.ts', '**/*.test.tsx'],
      exclude: UNIT_TEST_EXCLUDE,
      coverage: {
        provider: 'v8',
        include: ['src/**'],
        reporter: ['text-summary', 'json-summary'],
        ...(threshold === undefined ? {} : { thresholds: { lines: threshold } }),
      },
    },
  });
}

/** Integration tests: only `*.int.test.ts` and backend `*.e2e.test.ts`, one file at a time. */
export function integrationTestConfig() {
  return defineConfig({
    ...resolveConfig,
    test: {
      include: ['**/*.int.test.ts', '**/*.e2e.test.ts'],
      exclude: ['**/node_modules/**', '**/dist/**'],
      fileParallelism: false,
      testTimeout: 60_000,
      hookTimeout: 180_000,
    },
  });
}
