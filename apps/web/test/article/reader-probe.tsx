import type { ArticleListItem } from '@bantoozi/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';

import { useApi } from '../../src/api/context.js';
import { routes } from '../../src/api/routes.js';
import { ArticleRow } from '../../src/features/article/article-row.js';
import { articleKeys } from '../../src/features/article/query-keys.js';
import { useObserveItems, useReaderActions } from '../../src/features/reader/actions/provider.js';
import type { ReaderActions } from '../../src/features/reader/actions/types.js';
import { useAccountId } from '../../src/session/context.js';

/** What the probe page shows (set before the app renders) and the store it found (read afterwards). */
export const probe: { items: ArticleListItem[]; store: ReaderActions | null } = {
  items: [],
  store: null,
};

const noop = () => {};

/**
 * Stands in for the reader page: it renders `probe.items` as rows and a counts query, the pieces
 * the reader action provider has to serve, without the list this task does not own.
 */
export function ProbePage() {
  const api = useApi();
  const accountId = useAccountId();
  const store = useReaderActions();
  useEffect(() => {
    probe.store = store;
  }, [store]);
  useObserveItems(probe.items);
  const counts = useQuery({
    queryKey: articleKeys.counts(accountId),
    queryFn: ({ signal }) => api.call(routes.articleCounts, undefined, { signal }),
  });
  return (
    <div>
      <p data-testid="total">{counts.data === undefined ? 'loading' : counts.data.total}</p>
      <ul>
        {probe.items.map((item) => (
          <li key={item.id}>
            <ArticleRow item={item} expanded={false} onToggleExpand={noop} simple={false} />
          </li>
        ))}
      </ul>
    </div>
  );
}
