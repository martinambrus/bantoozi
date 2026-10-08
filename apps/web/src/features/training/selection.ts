import { MAX_ANALYZE_ARTICLES, type ArticleListItem } from '@bantoozi/shared';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useToast } from '../../components/toast/toast-provider.js';

/** The most articles one analysis request takes (spec 09 §3.2). */
export const MAX_SELECTED_ARTICLES = MAX_ANALYZE_ARTICLES;

export interface ArticleSelection {
  /** The selected articles, in the order they were selected. */
  readonly items: readonly ArticleListItem[];
  has(articleId: string): boolean;
  /**
   * Selects or deselects an article. Selecting one beyond the limit changes nothing, tells the
   * person so and answers false; every other call answers true.
   */
  toggle(item: ArticleListItem, on: boolean): boolean;
  remove(articleIds: readonly string[]): void;
  clear(): void;
}

/**
 * The articles a person has chosen to have analyzed (spec 06 §10): never filled by the app, and at
 * most as many as the API takes at once. Several calls in one event see each other's changes.
 */
export function useArticleSelection(): ArticleSelection {
  const { t } = useTranslation('training');
  const toast = useToast();
  const [items, setItems] = useState<readonly ArticleListItem[]>([]);
  const latest = useRef<readonly ArticleListItem[]>(items);

  const replace = useCallback((next: readonly ArticleListItem[]) => {
    latest.current = next;
    setItems(next);
  }, []);

  const toggle = useCallback(
    (item: ArticleListItem, on: boolean): boolean => {
      const held = latest.current;
      const selected = held.some((candidate) => candidate.id === item.id);
      if (!on) {
        if (selected) replace(held.filter((candidate) => candidate.id !== item.id));
        return true;
      }
      if (selected) return true;
      if (held.length >= MAX_SELECTED_ARTICLES) {
        toast.show({ message: t('limit', { max: MAX_SELECTED_ARTICLES }), tone: 'info' });
        return false;
      }
      replace([...held, item]);
      return true;
    },
    [replace, t, toast],
  );

  const remove = useCallback(
    (articleIds: readonly string[]) => {
      const held = latest.current;
      const kept = held.filter((candidate) => !articleIds.includes(candidate.id));
      if (kept.length !== held.length) replace(kept);
    },
    [replace],
  );

  const clear = useCallback(() => {
    if (latest.current.length > 0) replace([]);
  }, [replace]);

  const ids = useMemo(() => new Set(items.map((item) => item.id)), [items]);
  const has = useCallback((articleId: string) => ids.has(articleId), [ids]);

  return useMemo(
    () => ({ items, has, toggle, remove, clear }),
    [items, has, toggle, remove, clear],
  );
}
