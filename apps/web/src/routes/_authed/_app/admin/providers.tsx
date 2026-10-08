import { createFileRoute } from '@tanstack/react-router';

import { AdminProvidersPage } from '../../../../features/admin/providers-page.js';

export const Route = createFileRoute('/_authed/_app/admin/providers')({
  component: AdminProvidersPage,
});
