import { createFileRoute } from '@tanstack/react-router';

import { InterestsPage } from '../../../features/interests/interests-page.js';

export const Route = createFileRoute('/_authed/_app/interests')({
  component: InterestsPage,
});
