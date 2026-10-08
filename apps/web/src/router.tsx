import { createRouter, type RouterHistory } from '@tanstack/react-router';

import { RouteError } from './features/offline/route-error.js';
import type { RouterContext } from './router-context.js';
import { routeTree } from './routeTree.gen.js';

export function createAppRouter(context: RouterContext, history?: RouterHistory) {
  return createRouter({
    routeTree,
    context,
    defaultPreload: 'intent',
    defaultErrorComponent: RouteError,
    ...(history === undefined ? {} : { history }),
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
