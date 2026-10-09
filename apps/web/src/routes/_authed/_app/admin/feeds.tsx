import { createFileRoute } from '@tanstack/react-router';

import { AdminFeedsPage } from '../../../../features/admin/feeds-page.js';
import { FeedsSearchSchema } from '../../../../features/admin/search.js';

export const Route = createFileRoute('/_authed/_app/admin/feeds')({
  validateSearch: FeedsSearchSchema,
  component: AdminFeedsPage,
});
