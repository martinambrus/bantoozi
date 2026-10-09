import { createFileRoute } from '@tanstack/react-router';

import { SettingsPage } from '../../../features/settings/settings-page.js';

export const Route = createFileRoute('/_authed/_app/settings')({
  component: SettingsPage,
});
