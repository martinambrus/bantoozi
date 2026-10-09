import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { OnboardingPage } from '../../features/onboarding/onboarding-page.js';
import { STEPS } from '../../features/onboarding/steps.js';

export const Route = createFileRoute('/_authed/onboarding')({
  // A step the address names wrongly shows the first one.
  validateSearch: z.object({ step: z.enum(STEPS).optional().catch(undefined) }),
  component: OnboardingRoute,
});

function OnboardingRoute() {
  const search = Route.useSearch();
  return <OnboardingPage step={search.step} />;
}
