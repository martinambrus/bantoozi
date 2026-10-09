import { createFileRoute } from '@tanstack/react-router';

import { AdminInvitesPage } from '../../../../features/admin/invites-page.js';
import { InvitesSearchSchema } from '../../../../features/admin/search.js';

export const Route = createFileRoute('/_authed/_app/admin/invites')({
  validateSearch: InvitesSearchSchema,
  component: AdminInvitesPage,
});
