import { createFileRoute } from '@tanstack/react-router';

import { ReaderPage } from '../../../../../features/reader/reader-page.js';

export const Route = createFileRoute('/_authed/_app/read/feed/$feedId')({
  component: FeedRoute,
});

function FeedRoute() {
  const { feedId } = Route.useParams();
  return <ReaderPage view={{ kind: 'feed', feedId }} />;
}
