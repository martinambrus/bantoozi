import { createFileRoute } from '@tanstack/react-router';

import { LabelsPage } from '../../../features/labels/labels-page.js';

export const Route = createFileRoute('/_authed/_app/labels')({
  component: LabelsPage,
});
