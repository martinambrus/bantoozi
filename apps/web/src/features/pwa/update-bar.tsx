import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/button.js';
import { IconButton } from '../../components/icon-button.js';
import { CloseIcon, InfoIcon } from '../../components/icons.js';

const HEIGHT_VARIABLE = '--update-bar-height';

export interface UpdateBarProps {
  message: string;
  onReload: () => void;
  onDismiss: () => void;
}

/**
 * The notice of a new version: a bar at the top of the page that pushes the content down. While it
 * shows, its height is in `--update-bar-height` on the root element, for the sticky headers and
 * panes below it to keep clear of; the variable goes with the bar.
 */
export function UpdateBar({ message, onReload, onDismiss }: UpdateBarProps) {
  const { t } = useTranslation('pwa');
  const bar = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = bar.current;
    if (element === null) return;
    const root = document.documentElement;
    const measure = () => root.style.setProperty(HEIGHT_VARIABLE, `${element.offsetHeight}px`);
    measure();
    if (typeof ResizeObserver === 'undefined')
      return () => root.style.removeProperty(HEIGHT_VARIABLE);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.removeProperty(HEIGHT_VARIABLE);
    };
  }, []);

  return (
    <div
      ref={bar}
      role="status"
      data-testid="update-bar"
      className="sticky top-0 z-40 border-b border-indigo-300 bg-indigo-50 pt-[env(safe-area-inset-top)] text-sm font-medium text-indigo-950 dark:border-indigo-700 dark:bg-indigo-950 dark:text-indigo-100"
    >
      <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-1">
        <InfoIcon className="size-4 shrink-0" />
        <span className="min-w-0 flex-1">{message}</span>
        <Button size="sm" onClick={onReload}>
          {t('update.reload')}
        </Button>
        <IconButton label={t('update.dismiss')} onClick={onDismiss} className="-mr-2">
          <CloseIcon />
        </IconButton>
      </div>
    </div>
  );
}
