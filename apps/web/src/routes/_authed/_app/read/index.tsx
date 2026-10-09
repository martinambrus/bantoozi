import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_authed/_app/read/')({
  beforeLoad: () => {
    throw redirect({ to: '/read/$lane', params: { lane: 'for_you' } });
  },
});
