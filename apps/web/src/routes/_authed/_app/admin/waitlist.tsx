import { createFileRoute } from '@tanstack/react-router';

import { AdminWaitlistPage } from '../../../../features/admin/waitlist-page.js';

export const Route = createFileRoute('/_authed/_app/admin/waitlist')({
  component: AdminWaitlistPage,
});
