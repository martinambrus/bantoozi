import { defineConfig, mergeConfig } from 'vitest/config';

import { unitTestConfig } from '../../vitest.shared.js';
import viteConfig from './vite.config.js';

// Component tests run in jsdom; test/setup.ts fills its gaps (pointer capture, matchMedia, IndexedDB).
export default mergeConfig(
  viteConfig,
  mergeConfig(
    unitTestConfig(),
    defineConfig({ test: { environment: 'jsdom', setupFiles: ['./test/setup.ts'] } }),
  ),
);
