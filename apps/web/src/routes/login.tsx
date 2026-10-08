import { createFileRoute, redirect } from '@tanstack/react-router';
import { z } from 'zod';

import { LoginPage } from '../features/auth/login-page.js';
import { safeRedirect } from '../features/auth/safe-redirect.js';

export const Route = createFileRoute('/login')({
  validateSearch: z.object({ redirect: z.string().optional().catch(undefined) }),
  // Someone who is already signed in has nothing to do here.
  beforeLoad: async ({ context, search }) => {
    if ((await context.loadMe()) !== null) throw redirect({ href: safeRedirect(search.redirect) });
  },
  component: LoginRoute,
});

function LoginRoute() {
  const search = Route.useSearch();
  return <LoginPage redirect={search.redirect} />;
}
