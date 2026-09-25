import { createFileRoute } from '@tanstack/react-router';

import { HomePage } from '../features/home/home-page.js';

export const Route = createFileRoute('/')({
  component: HomePage,
});
