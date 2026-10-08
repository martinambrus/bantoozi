import { createFileRoute } from '@tanstack/react-router';

import { ReaderPage } from '../../../../../features/reader/reader-page.js';

export const Route = createFileRoute('/_authed/_app/read/label/$labelId')({
  component: LabelRoute,
});

function LabelRoute() {
  const { labelId } = Route.useParams();
  return <ReaderPage view={{ kind: 'label', labelId }} />;
}
