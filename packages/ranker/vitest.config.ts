import { unitTestConfig } from '../../vitest.shared.js';

// The trainer tests fit whole models: slow on a shared CI runner under coverage.
export default unitTestConfig({ coverageLinesThreshold: 80, testTimeout: 30_000 });
