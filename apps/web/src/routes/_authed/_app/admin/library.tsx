import { createFileRoute } from '@tanstack/react-router';

import { AdminLibraryPage } from '../../../../features/admin/library-page.js';
import { LibrarySearchSchema } from '../../../../features/admin/search.js';

export const Route = createFileRoute('/_authed/_app/admin/library')({
  validateSearch: LibrarySearchSchema,
  component: AdminLibraryPage,
});
