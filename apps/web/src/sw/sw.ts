/// <reference lib="webworker" />
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare let self: ServiceWorkerGlobalScope;

// Spec 09 §1: precache only the versioned public app shell. There is deliberately no runtime
// caching and no catch-all fetch handler: API responses, counts, auth, admin data and remote images
// never pass through this cache. Private offline data lives in the account-scoped IndexedDB store.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Navigations fall back to the app shell, except the API and the static /privacy and /bot pages
// (spec 11 §3) that Caddy serves itself.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    denylist: [/^\/api(\/|$)/, /^\/privacy(\/|$)/, /^\/bot(\/|$)/],
  }),
);

// The update prompt (registerType 'prompt') asks the waiting worker to take over.
self.addEventListener('message', (event: ExtendableMessageEvent) => {
  if ((event.data as { type?: string } | null)?.type === 'SKIP_WAITING') void self.skipWaiting();
});
