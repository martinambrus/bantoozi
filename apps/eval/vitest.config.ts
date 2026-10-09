import { mergeConfig } from 'vitest/config';

import { unitTestConfig } from '../../vitest.shared.js';

// The report tests build whole evaluation runs: under coverage on a CI runner one takes over 5 s.
export default mergeConfig(unitTestConfig(), { test: { testTimeout: 30_000 } });
