import { createFileRoute } from '@tanstack/react-router';

import { OnboardingPage } from '../../features/onboarding/onboarding-page.js';

export const Route = createFileRoute('/_authed/onboarding')({
  component: OnboardingPage,
});
