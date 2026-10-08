import type { ArticleListItem } from '@bantoozi/shared';
import { useEffect, useState } from 'react';

import { ArticleRow } from '../../src/features/article/article-row.js';
import { useObserveItems, useReaderActions } from '../../src/features/reader/actions/provider.js';
import type { ReaderActions } from '../../src/features/reader/actions/types.js';

/** The page every tab of these tests shows: rows of `page.items`, and a handle on the tab's store. */
export interface TabControl {
  store: ReaderActions;
  show(items: ArticleListItem[]): void;
}

export const page: { items: ArticleListItem[]; tabs: TabControl[] } = { items: [], tabs: [] };

export function resetPage(items: ArticleListItem[] = []): void {
  page.items = items;
  page.tabs = [];
}

export function TabPage() {
  const store = useReaderActions();
  const [items, setItems] = useState(page.items);
  useObserveItems(items);
  useEffect(() => {
    const control: TabControl = { store, show: setItems };
    page.tabs.push(control);
    return () => {
      page.tabs.splice(page.tabs.indexOf(control), 1);
    };
  }, [store]);
  return (
    <ul>
      {items.map((item) => (
        <li key={item.id}>
          <ArticleRow item={item} expanded={false} onToggleExpand={() => {}} simple={false} />
        </li>
      ))}
    </ul>
  );
}
