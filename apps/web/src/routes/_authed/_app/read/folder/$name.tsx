import { createFileRoute } from '@tanstack/react-router';

import { ReaderPage } from '../../../../../features/reader/reader-page.js';

export const Route = createFileRoute('/_authed/_app/read/folder/$name')({
  component: FolderRoute,
});

function FolderRoute() {
  const { name } = Route.useParams();
  return <ReaderPage view={{ kind: 'folder', name }} />;
}
