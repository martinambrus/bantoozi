import { createFileRoute } from '@tanstack/react-router';

import { ReaderLayout } from '../../../../features/reader/reader-layout.js';

export const Route = createFileRoute('/_authed/_app/read')({
  component: ReaderLayout,
});
