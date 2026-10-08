import { createFileRoute, notFound } from '@tanstack/react-router';

import { AdminLayout } from '../../../../features/admin/admin-layout.js';

// Spec 09 §2: admin screens exist only for admins; everyone else gets the not-found screen.
export const Route = createFileRoute('/_authed/_app/admin')({
  beforeLoad: ({ context }) => {
    if (context.me.role !== 'admin') throw notFound();
  },
  component: AdminLayout,
});
