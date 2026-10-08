import type { ArticleListItem } from '@bantoozi/shared';
import { useTranslation } from 'react-i18next';

import { Sheet } from '../../components/sheet.js';
import { Explanation } from './explanation.js';

export interface WhyThisSheetProps {
  /** The article as the reader lists it. */
  item: ArticleListItem;
  /** The feed the reader is looking at; the detail is projected like its rows (spec 08 §5.2). */
  sourceFeedId?: string | undefined;
  /** The Bookmarks view: the explanation of the saved copy. */
  saved?: boolean | undefined;
  open: boolean;
  onClose: () => void;
}

/** The "Why this?" drawer (spec 09 §3.5): why the article is where it is and how to correct it. */
export function WhyThisSheet({ item, sourceFeedId, saved, open, onClose }: WhyThisSheetProps) {
  const { t } = useTranslation('why');
  return (
    <Sheet open={open} onClose={onClose} title={t('title')} description={item.title}>
      <Explanation item={item} sourceFeedId={sourceFeedId} saved={saved} />
    </Sheet>
  );
}
