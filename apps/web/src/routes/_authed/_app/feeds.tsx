import { createFileRoute } from '@tanstack/react-router';

import { FeedsPage } from '../../../features/feeds/feeds-page.js';

export const Route = createFileRoute('/_authed/_app/feeds')({
  component: FeedsPage,
});
