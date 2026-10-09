import { createFileRoute } from '@tanstack/react-router';

import { AdminSettingsPage } from '../../../../features/admin/settings-page.js';

export const Route = createFileRoute('/_authed/_app/admin/settings')({
  component: AdminSettingsPage,
});
