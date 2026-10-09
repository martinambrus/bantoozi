import { createFileRoute } from '@tanstack/react-router';

import { UsageSearchSchema } from '../../../../features/admin/search.js';
import { AdminUsagePage } from '../../../../features/admin/usage-page.js';

export const Route = createFileRoute('/_authed/_app/admin/usage')({
  validateSearch: UsageSearchSchema,
  component: AdminUsagePage,
});
