import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';
import { useCallback, useSyncExternalStore } from 'react';

import { meKey } from '../../api/query-keys.js';

// Spec 09 §2: every screen except login, join and waitlist needs a session; the first-run wizard
// runs while `preferences.onboardingCompletedAt` is null.
export const Route = createFileRoute('/_authed')({
  beforeLoad: async ({ context, location }) => {
    const me = await context.loadMe();
    if (me === null) throw redirect({ to: '/login', search: { redirect: location.href } });
    if (me.preferences.onboardingCompletedAt === null && location.pathname !== '/onboarding') {
      throw redirect({ to: '/onboarding' });
    }
    return { me };
  },
  component: AuthedLayout,
});

// When the account goes (sign-out, a 401, another tab) the router redirects a moment later; until
// then nothing below may render, because `useMe()` has no account to return.
function AuthedLayout() {
  const { queryClient } = Route.useRouteContext();
  const subscribe = useCallback(
    (notify: () => void) => queryClient.getQueryCache().subscribe(notify),
    [queryClient],
  );
  const signedOut = useSyncExternalStore(
    subscribe,
    () => queryClient.getQueryData(meKey()) === null,
  );
  return signedOut ? null : <Outlet />;
}
