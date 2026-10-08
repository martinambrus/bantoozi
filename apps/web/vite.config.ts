import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Workspace packages resolve to their TypeScript sources through this export condition.
const SOURCE_CONDITION = 'bantoozi-source';

// The API runs on the host in development (spec 01 §8); Caddy does this in production. The E2E
// environment points the preview server at its own API port (spec 09 §9).
const API_PROXY_TARGET = process.env.BANTOOZI_API_PROXY ?? 'http://127.0.0.1:3000';

// Extra image origins for the preview server only: E2E serves fixture images from loopback http
// ports, which the production `img-src 'self' https:` would block. Production headers come from Caddy.
const PREVIEW_IMG_SRC = process.env.BANTOOZI_PREVIEW_IMG_SRC ?? '';

// The production security headers of spec 11 §7 (infra/caddy/Caddyfile). Only `vite preview` sends
// them: the dev server's React refresh preamble is an inline script that `script-src 'self'` blocks.
const PREVIEW_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    `img-src 'self' https:${PREVIEW_IMG_SRC === '' ? '' : ` ${PREVIEW_IMG_SRC}`}`,
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

export default defineConfig({
  resolve: { conditions: [SOURCE_CONDITION, ...defaultClientConditions] },
  plugins: [
    // The router plugin generates src/routeTree.gen.ts from src/routes; it must run before react().
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    // Spec 09 §1: the service worker precaches the versioned public app shell only. The app
    // registers it through `virtual:pwa-register/react` (an inline register script would break the
    // CSP), and src/sw/sw.ts adds the navigation fallback and the optional Background Sync hook.
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src/sw',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['apple-touch-icon-180x180.png'],
      manifest: {
        name: 'Bantoozi',
        short_name: 'Bantoozi',
        description: 'Feed reader with a taste',
        lang: 'en',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        theme_color: '#0f172a',
        background_color: '#ffffff',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      injectManifest: { globPatterns: ['**/*.{js,css,html}'] },
    }),
  ],
  // `data:` URIs are blocked by the production `img-src` (spec 11 §7), so never inline assets.
  build: { assetsInlineLimit: 0 },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': API_PROXY_TARGET },
  },
  // `vite preview` inherits the proxy and strictPort from `server`.
  preview: { headers: PREVIEW_HEADERS },
});
