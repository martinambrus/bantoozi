import { createFileRoute, notFound } from '@tanstack/react-router';

import { isLane } from '../../../../features/reader/lanes.js';
import { ReaderPage } from '../../../../features/reader/reader-page.js';

export const Route = createFileRoute('/_authed/_app/read/$lane')({
  params: {
    parse: ({ lane }) => {
      if (!isLane(lane)) throw notFound();
      return { lane };
    },
    stringify: ({ lane }) => ({ lane }),
  },
  component: LaneRoute,
});

function LaneRoute() {
  const { lane } = Route.useParams();
  return <ReaderPage view={{ kind: 'lane', lane }} />;
}
