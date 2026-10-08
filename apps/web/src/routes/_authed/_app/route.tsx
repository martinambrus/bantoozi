import { createFileRoute } from '@tanstack/react-router';

import { AppShell } from '../../../features/shell/app-shell.js';

export const Route = createFileRoute('/_authed/_app')({
  component: AppShell,
});
