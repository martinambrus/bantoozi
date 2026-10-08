import { createFileRoute } from '@tanstack/react-router';

import { AdminOverviewPage } from '../../../../features/admin/overview-page.js';

export const Route = createFileRoute('/_authed/_app/admin/')({
  component: AdminOverviewPage,
});
