import { createFileRoute } from '@tanstack/react-router';

import { ReaderPage } from '../../../../../features/reader/reader-page.js';
import { ScopedSearchSchema } from '../../../../../features/reader/search.js';

export const Route = createFileRoute('/_authed/_app/read/feed/$feedId')({
  validateSearch: ScopedSearchSchema,
  component: FeedRoute,
});

function FeedRoute() {
  const { feedId } = Route.useParams();
  const { lane } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ReaderPage
      view={{ kind: 'feed', feedId, lane: lane ?? 'all' }}
      onLaneChange={(next) =>
        void navigate({
          search: (previous) => ({ ...previous, lane: next === 'all' ? undefined : next }),
        })
      }
    />
  );
}
