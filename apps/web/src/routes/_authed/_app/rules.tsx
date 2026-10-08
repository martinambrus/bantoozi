import { createFileRoute } from '@tanstack/react-router';

import { RulesPage } from '../../../features/rules/rules-page.js';

export const Route = createFileRoute('/_authed/_app/rules')({
  component: RulesPage,
});
