import { createFileRoute } from '@tanstack/react-router';

import { AdminUsersPage } from '../../../../features/admin/users-page.js';

export const Route = createFileRoute('/_authed/_app/admin/users')({
  component: AdminUsersPage,
});
