import { createFileRoute } from '@tanstack/react-router';

import { AdminLibraryPage } from '../../../../features/admin/library-page.js';

export const Route = createFileRoute('/_authed/_app/admin/library')({
  component: AdminLibraryPage,
});
