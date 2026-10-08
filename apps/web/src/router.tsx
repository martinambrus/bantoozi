import { createRouter, type RouterHistory } from '@tanstack/react-router';

import type { RouterContext } from './router-context.js';
import { routeTree } from './routeTree.gen.js';

export function createAppRouter(context: RouterContext, history?: RouterHistory) {
  return createRouter({
    routeTree,
    context,
    defaultPreload: 'intent',
    ...(history === undefined ? {} : { history }),
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
