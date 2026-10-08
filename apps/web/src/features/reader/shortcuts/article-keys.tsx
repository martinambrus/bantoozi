import type { ArticleListItem, RuleExpiryDays } from '@bantoozi/shared';
import { useLayoutEffect, type RefObject } from 'react';

import { httpUrl } from '../../article/http-url.js';
import { useArticleActions } from '../../article/use-article-actions.js';
import { useRuleActions } from '../../article/use-rule-actions.js';
import { useReaderItem, useReturnTracker } from '../actions/provider.js';

/** What the keys do to one article, through the code its buttons use. */
export interface ArticleHandle {
  id: string;
  /** Opens the original in a new tab; false when the article has no link to follow. */
  openOriginal(): boolean;
  rate(pressed: 1 | -1, hide: boolean): void;
  toggleBookmark(): void;
  toggleRead(): void;
  muteStory(days: RuleExpiryDays): void;
}

export interface ArticleKeysProps {
  item: ArticleListItem;
  /** Holds the handle of the article for as long as this is rendered. */
  handle: RefObject<ArticleHandle | null>;
}

/**
 * The actions of the article the keys act on. They are hooks, as the buttons of a row and of the
 * detail have them, so this renders nothing and hands them out through `handle`. Render it with
 * the article's id as its key.
 */
export function ArticleKeys({ item, handle }: ArticleKeysProps) {
  const shown = useReaderItem(item);
  const actions = useArticleActions(shown);
  const rules = useRuleActions(shown);
  const tracker = useReturnTracker();

  useLayoutEffect(() => {
    handle.current = {
      id: item.id,
      openOriginal() {
        const original = httpUrl(shown.url);
        if (original === null) return false;
        window.open(original.href, '_blank', 'noopener,noreferrer');
        actions.open();
        tracker.track(shown);
        return true;
      },
      rate: (pressed, hide) => actions.rate(pressed, { hide }),
      toggleBookmark: actions.toggleBookmark,
      toggleRead: actions.toggleRead,
      muteStory: rules.muteStory,
    };
  });

  useLayoutEffect(
    () => () => {
      handle.current = null;
    },
    [handle],
  );

  return null;
}
