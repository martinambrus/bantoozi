import { createFileRoute } from '@tanstack/react-router';

import { ReaderPage } from '../../../../../features/reader/reader-page.js';
import { ScopedSearchSchema } from '../../../../../features/reader/search.js';

export const Route = createFileRoute('/_authed/_app/read/folder/$name')({
  validateSearch: ScopedSearchSchema,
  component: FolderRoute,
});

function FolderRoute() {
  const { name } = Route.useParams();
  const { lane } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ReaderPage
      view={{ kind: 'folder', name, lane: lane ?? 'all' }}
      onLaneChange={(next) =>
        void navigate({
          search: (previous) => ({ ...previous, lane: next === 'all' ? undefined : next }),
        })
      }
    />
  );
}
