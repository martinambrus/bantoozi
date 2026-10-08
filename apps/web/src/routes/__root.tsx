import { Outlet, createRootRouteWithContext } from '@tanstack/react-router';

import { ToastProvider } from '../components/toast/toast-provider.js';
import { Toaster } from '../components/toast/toaster.js';
import type { RouterContext } from '../router-context.js';
import { ThemeSync } from '../theme/theme-sync.js';

export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <ToastProvider>
      <ThemeSync />
      <div className="min-h-screen bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
        <Outlet />
      </div>
      <Toaster />
    </ToastProvider>
  ),
});
