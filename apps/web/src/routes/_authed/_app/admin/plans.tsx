import { createFileRoute } from '@tanstack/react-router';
import { AdminPlansPage } from '../../../../features/admin/plans-page.js';
export const Route = createFileRoute('/_authed/_app/admin/plans')({ component: AdminPlansPage });
