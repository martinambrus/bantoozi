import type { BookmarkCapture } from '@bantoozi/shared';
import { useTranslation } from 'react-i18next';

import { Badge, type BadgeTone } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { RefreshIcon } from '../../components/icons.js';

const TONES: Record<BookmarkCapture['status'], BadgeTone> = {
  pending: 'info',
  saved: 'success',
  partial: 'warning',
  failed: 'danger',
};

export interface CapturePanelProps {
  capture: BookmarkCapture;
  onRetry: () => void;
}

/** How far saving a bookmarked article got (spec 09 §3.2), and what the reader can do about it. */
export function CapturePanel({ capture, onRetry }: CapturePanelProps) {
  const { t } = useTranslation('article');
  const { status } = capture;
  const incomplete = status === 'partial' || status === 'failed';
  const archived = status === 'saved' || status === 'partial';

  return (
    <div className="flex flex-col items-start gap-2">
      <Badge tone={TONES[status]}>{t(`capture.${status}`)}</Badge>
      {incomplete ? (
        <p className="text-sm text-slate-700 dark:text-slate-200">{t('capture.limits')}</p>
      ) : null}
      {archived ? (
        <p className="text-sm text-slate-700 dark:text-slate-200">{t('capture.media')}</p>
      ) : null}
      {incomplete ? (
        <Button variant="secondary" onClick={onRetry}>
          <RefreshIcon className="size-4" />
          {t('capture.retry')}
        </Button>
      ) : null}
    </div>
  );
}
