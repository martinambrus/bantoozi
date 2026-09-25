import { defaultClientConditions, defineConfig } from 'vite';

// Workspace packages resolve to their TypeScript sources through this export condition.
const SOURCE_CONDITION = 'bantoozi-source';

export default defineConfig({
  resolve: { conditions: [SOURCE_CONDITION, ...defaultClientConditions] },
});
