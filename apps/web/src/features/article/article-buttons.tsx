import { useTranslation } from 'react-i18next';

import { cx } from '../../components/cx.js';
import {
  BookmarkFilledIcon,
  BookmarkIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
} from '../../components/icons.js';
import { IconButton } from '../../components/icon-button.js';

// A pressed button is filled and tinted, so it is not told from the others by colour alone.
const PRESSED = 'bg-indigo-100 text-indigo-900 dark:bg-indigo-900 dark:text-indigo-100';

export interface RateButtonsProps {
  rating: 1 | -1 | null;
  onRate: (pressed: 1 | -1) => void;
}

/** 👍 / 👎 (spec 09 §3.3): both are toggles of the displayed rating. */
export function RateButtons({ rating, onRate }: RateButtonsProps) {
  const { t } = useTranslation('article');
  return (
    <>
      <IconButton
        label={t('actions.like')}
        aria-pressed={rating === 1}
        className={cx(rating === 1 && PRESSED)}
        onClick={() => onRate(1)}
      >
        <ThumbsUpIcon fill={rating === 1 ? 'currentColor' : 'none'} />
      </IconButton>
      <IconButton
        label={t('actions.dislike')}
        aria-pressed={rating === -1}
        className={cx(rating === -1 && PRESSED)}
        onClick={() => onRate(-1)}
      >
        <ThumbsDownIcon fill={rating === -1 ? 'currentColor' : 'none'} />
      </IconButton>
    </>
  );
}

export interface BookmarkButtonProps {
  bookmarked: boolean;
  onToggle: () => void;
}

export function BookmarkButton({ bookmarked, onToggle }: BookmarkButtonProps) {
  const { t } = useTranslation('article');
  const Icon = bookmarked ? BookmarkFilledIcon : BookmarkIcon;
  return (
    <IconButton
      label={t('actions.bookmark')}
      aria-pressed={bookmarked}
      className={cx(bookmarked && PRESSED)}
      onClick={onToggle}
    >
      <Icon />
    </IconButton>
  );
}
