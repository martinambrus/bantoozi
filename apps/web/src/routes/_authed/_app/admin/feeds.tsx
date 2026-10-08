import { createFileRoute } from '@tanstack/react-router';

import { AdminFeedsPage } from '../../../../features/admin/feeds-page.js';

export const Route = createFileRoute('/_authed/_app/admin/feeds')({
  component: AdminFeedsPage,
});
