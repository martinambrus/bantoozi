import { createFileRoute } from '@tanstack/react-router';

import { UsersSearchSchema } from '../../../../features/admin/search.js';
import { AdminUsersPage } from '../../../../features/admin/users-page.js';

export const Route = createFileRoute('/_authed/_app/admin/users')({
  validateSearch: UsersSearchSchema,
  component: AdminUsersPage,
});
