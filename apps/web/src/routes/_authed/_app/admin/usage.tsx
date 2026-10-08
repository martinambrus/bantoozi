import { createFileRoute } from '@tanstack/react-router';

import { AdminUsagePage } from '../../../../features/admin/usage-page.js';

export const Route = createFileRoute('/_authed/_app/admin/usage')({
  component: AdminUsagePage,
});
