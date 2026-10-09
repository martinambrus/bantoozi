import type { ArticleListItem } from '@bantoozi/shared';
import { useCallback, useEffect, useState } from 'react';

import { readDetail, readView } from '../../offline/cache.js';
import type { OfflineItem } from '../../offline/projection.js';

export interface SavedList {
  items: ArticleListItem[];
  savedAt: number;
}

/** A saved row as a list row. The ranking is never kept on the device, so none of it is claimed. */
export function listItemOf(saved: OfflineItem): ArticleListItem {
  return { ...saved, lane: 'new', tier: null, pLike: null };
}

/**
 * What the device kept, read when `wanted` turns true: undefined until it is read, null when there
 * is none. A copy that was read by another `read` is never returned.
 */
function useSavedCopy<T>(wanted: boolean, read: () => Promise<T | null>): T | null | undefined {
  const [found, setFound] = useState<{ read: () => Promise<T | null>; value: T | null }>();
  useEffect(() => {
    if (!wanted) return;
    let current = true;
    void read().then((value) => {
      if (current) setFound({ read, value });
    });
    return () => {
      current = false;
    };
  }, [wanted, read]);
  return found?.read === read ? found.value : undefined;
}

/** The rows saved for a view. A copy without rows is none: it would show an empty list as true. */
export function useSavedList(
  accountId: string,
  which: string,
  wanted: boolean,
): SavedList | null | undefined {
  const read = useCallback(async () => {
    const view = await readView(accountId, which);
    return view === null || view.items.length === 0
      ? null
      : { items: view.items.map(listItemOf), savedAt: view.savedAt };
  }, [accountId, which]);
  return useSavedCopy(wanted, read);
}

export function useSavedDetail(accountId: string, articleId: string, wanted: boolean) {
  const read = useCallback(() => readDetail(accountId, articleId), [accountId, articleId]);
  return useSavedCopy(wanted, read);
}
