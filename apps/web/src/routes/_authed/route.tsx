import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';

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
  component: () => <Outlet />,
});
