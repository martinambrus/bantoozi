import { mergeConfig } from 'vitest/config';

import { unitTestConfig } from '../../vitest.shared.js';

// The parse tests decode and sanitize whole feeds: under coverage on a CI runner, beside the other
// packages' suites, some take over half of the 5 s default.
export default mergeConfig(unitTestConfig({ coverageLinesThreshold: 80 }), {
  test: { testTimeout: 30_000 },
});
