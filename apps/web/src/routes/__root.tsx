import { Outlet, createRootRouteWithContext } from '@tanstack/react-router';

import type { RouterContext } from '../router-context.js';

export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <div className="min-h-screen bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <Outlet />
    </div>
  ),
});
