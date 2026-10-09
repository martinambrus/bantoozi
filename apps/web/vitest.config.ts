import { defineConfig, mergeConfig } from 'vitest/config';

import { unitTestConfig } from '../../vitest.shared.js';
import viteConfig from './vite.config.js';

// Component tests run in jsdom; test/setup.ts fills its gaps (pointer capture, matchMedia, IndexedDB).
// A screen test drives the whole app: under coverage on a CI runner the first one of a file, which
// loads the screen's code, has taken over 5 s.
export default mergeConfig(
  viteConfig,
  mergeConfig(
    unitTestConfig(),
    defineConfig({
      test: { environment: 'jsdom', setupFiles: ['./test/setup.ts'], testTimeout: 30_000 },
    }),
  ),
);
