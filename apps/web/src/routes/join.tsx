import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { JoinPage } from '../features/auth/join-page.js';

export const Route = createFileRoute('/join')({
  validateSearch: z.object({ code: z.string().trim().min(1).max(64).optional().catch(undefined) }),
  component: JoinPage,
});
