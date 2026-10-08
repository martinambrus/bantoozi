import { createFileRoute } from '@tanstack/react-router';

import { WaitlistPage } from '../features/auth/waitlist-page.js';

export const Route = createFileRoute('/waitlist')({
  component: WaitlistPage,
});
