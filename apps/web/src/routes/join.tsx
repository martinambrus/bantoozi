import { createFileRoute, redirect } from '@tanstack/react-router';
import { z } from 'zod';

import { JoinPage } from '../features/auth/join-page.js';

export const Route = createFileRoute('/join')({
  validateSearch: z.object({ code: z.string().trim().min(1).max(64).optional().catch(undefined) }),
  // Someone who is already signed in has no use for an invite.
  beforeLoad: async ({ context }) => {
    if ((await context.loadMe()) !== null) throw redirect({ to: '/' });
  },
  component: JoinRoute,
});

function JoinRoute() {
  const search = Route.useSearch();
  return <JoinPage code={search.code} />;
}
