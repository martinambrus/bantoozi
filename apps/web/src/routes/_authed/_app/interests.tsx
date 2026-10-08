import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { InterestsPage } from '../../../features/interests/interests-page.js';
import { TABS } from '../../../features/interests/tabs.js';

export const Route = createFileRoute('/_authed/_app/interests')({
  // A section the address names wrongly shows the default one.
  validateSearch: z.object({ tab: z.enum(TABS).optional().catch(undefined) }),
  component: InterestsRoute,
});

function InterestsRoute() {
  const search = Route.useSearch();
  return <InterestsPage tab={search.tab} />;
}
