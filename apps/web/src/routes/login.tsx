import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { LoginPage } from '../features/auth/login-page.js';

export const Route = createFileRoute('/login')({
  validateSearch: z.object({ redirect: z.string().optional().catch(undefined) }),
  component: LoginPage,
});
