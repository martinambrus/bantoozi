import { createFileRoute } from '@tanstack/react-router';

import { SetupPage } from '../features/setup/setup-page.js';

// No sign-in guard: setup is open only while no admin exists, and a closed one goes to /login, which
// sends a signed-in visitor on. A guard here would race the redirect to /admin after the sign-in.
export const Route = createFileRoute('/setup')({
  component: SetupPage,
});
