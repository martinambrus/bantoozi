import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

// Workspace packages resolve to their TypeScript sources through this export condition.
const SOURCE_CONDITION = 'bantoozi-source';

export default defineConfig({
  resolve: { conditions: [SOURCE_CONDITION, ...defaultClientConditions] },
  // The router plugin generates src/routeTree.gen.ts from src/routes; it must run before react().
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    // The API runs on the host in development (spec 01 §8); Caddy does this in production.
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
});
