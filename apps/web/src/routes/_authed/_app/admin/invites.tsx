import { createFileRoute } from '@tanstack/react-router';

import { AdminInvitesPage } from '../../../../features/admin/invites-page.js';

export const Route = createFileRoute('/_authed/_app/admin/invites')({
  component: AdminInvitesPage,
});
