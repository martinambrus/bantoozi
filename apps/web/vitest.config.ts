import { mergeConfig } from 'vitest/config';

import { unitTestConfig } from '../../vitest.shared.js';
import viteConfig from './vite.config.js';

export default mergeConfig(viteConfig, unitTestConfig());
