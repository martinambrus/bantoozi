import type { Me } from '@bantoozi/shared';
import { hashKey } from '@tanstack/react-query';
import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';
import { useCallback, useSyncExternalStore } from 'react';

import { meKey } from '../../api/query-keys.js';
import { ReasonBar } from '../../features/article/reason-bar.js';
import { ReaderActionsProvider } from '../../features/reader/actions/provider.js';
import { AccountEffects } from '../../features/shell/account-effects.js';
import { DidYouLikePrompt } from '../../features/why/did-you-like-prompt.js';

// Spec 09 §2: every screen except login, join and waitlist needs a session; the first-run wizard
// runs while `preferences.onboardingCompletedAt` is null.
export const Route = createFileRoute('/_authed')({
  beforeLoad: async ({ context, location }) => {
    const me = await context.loadMe();
    if (me === null) throw redirect({ to: '/login', search: { redirect: location.href } });
    // An administrator may reach the administration before the wizard: the first admin created by
    // first-run setup (M8b-T11) has not been through it, and has the system to configure first.
    const adminArea = me.role === 'admin' && /^\/admin(\/|$)/.test(location.pathname);
    if (
      me.preferences.onboardingCompletedAt === null &&
      location.pathname !== '/onboarding' &&
      !adminArea
    ) {
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
    (notify: () => void) =>
      queryClient.getQueryCache().subscribe((event) => {
        // Query observers also notify while children render. Only account data changes affect
        // this snapshot; forwarding observer events can update this layout during their render.
        if (
          (event.type === 'updated' || event.type === 'removed') &&
          event.query.queryHash === hashKey(meKey())
        ) {
          notify();
        }
      }),
    [queryClient],
  );
  const me = useSyncExternalStore(subscribe, () => queryClient.getQueryData<Me | null>(meKey()));
  if (me === null) return null;
  const content = (
    <>
      <AccountEffects me={me} />
      <Outlet />
    </>
  );
  // Before the account has been asked for there is no id to scope the reader actions to, and only
  // screens that need no account render then.
  return me === undefined ? (
    content
  ) : (
    <ReaderActionsProvider accountId={me.id}>
      {content}
      <DidYouLikePrompt />
      <ReasonBar />
    </ReaderActionsProvider>
  );
}
