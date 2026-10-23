import { useTranslation } from 'react-i18next';

import { Button } from '../../components/button.js';
import { CloseIcon } from '../../components/icons.js';
import { IconButton } from '../../components/icon-button.js';
import type { EstimateNotice } from '../learning/estimate-run.js';

export interface EstimateNoticeBarProps {
  notice: EstimateNotice | null;
  onShow: () => void;
  onDismiss: () => void;
}

/**
 * Says how many unread articles the model's refresh moved up or down, and loads the list from
 * page one when Show is pressed; nothing moves before (design 4.5, D-243).
 */
export function EstimateNoticeBar({ notice, onShow, onDismiss }: EstimateNoticeBarProps) {
  const { t } = useTranslation('learning');
  const text =
    notice === null
      ? ''
      : notice.up > 0 && notice.down > 0
        ? t('notice.both', { count: notice.up, down: notice.down })
        : notice.up > 0
          ? t('notice.up', { count: notice.up })
          : t('notice.down', { count: notice.down });
  return (
    // One element in both states, so a screen reader hears the sentence when it appears.
    <div
      className={
        notice === null
          ? 'sr-only'
          : 'flex flex-wrap items-center gap-2 rounded-lg border border-slate-300 bg-slate-50 px-3 py-1 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100'
      }
    >
      <p role="status" className="min-w-0 flex-1 py-2">
        {text}
      </p>
      {notice === null ? null : (
        <>
          <Button variant="secondary" aria-label={t('notice.showLabel')} onClick={onShow}>
            {t('notice.show')}
          </Button>
          <IconButton label={t('notice.dismissLabel')} onClick={onDismiss}>
            <CloseIcon className="size-4" />
          </IconButton>
        </>
      )}
    </div>
  );
}
