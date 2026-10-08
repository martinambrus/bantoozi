import { MAX_RATE_BULK_TARGETS, type ArticleListItem } from '@bantoozi/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import type { ApiError } from '../../api/errors.js';
import { Button } from '../../components/button.js';
import { Dialog } from '../../components/dialog.js';
import { errorMessage } from '../../components/error-message.js';
import { WarningIcon } from '../../components/icons.js';
import { MenuItem } from '../../components/menu.js';
import { useToast } from '../../components/toast/toast-provider.js';
import { useAccountId } from '../../session/context.js';
import { articleKeys } from '../article/query-keys.js';
import { useReaderActions, useUndoAction } from './actions/provider.js';

const TOAST_ID = 'reader-rate-visible';
/** Spec 09 §3.3: the undo toast of a bulk action stays for 5 seconds. */
const UNDO_TOAST_MS = 5000;

/** The articles a question is about, as the list showed them when it was asked. */
export interface Asked {
  /** The unread rows of the list, the first 200 of them at most. */
  items: readonly ArticleListItem[];
  /** How many unread rows the list showed. */
  shown: number;
}

/** The unread rows among the ones the list shows (spec 09 §3.3). */
export function useVisibleUnread(visible: readonly ArticleListItem[]): Asked {
  const store = useReaderActions();
  useSyncExternalStore(store.subscribe, store.getVersion);
  const unread = visible.filter((item) => store.view(item).readAt === null);
  return { items: unread.slice(0, MAX_RATE_BULK_TARGETS), shown: unread.length };
}

export interface RateVisibleItemProps {
  asked: Asked;
  /** Opens the question. */
  onSelect: () => void;
}

/** The More-menu entry for rating the visible unread articles; off, and saying why, when none. */
export function RateVisibleItem({ asked, onSelect }: RateVisibleItemProps) {
  const { t } = useTranslation('reader');
  if (asked.items.length === 0) {
    return (
      <MenuItem disabled onSelect={onSelect}>
        <span className="flex flex-col py-1">
          <span>{t('header.rateVisibleNone')}</span>{' '}
          <span className="text-xs font-normal">{t('header.rateVisibleNoneWhy')}</span>
        </span>
      </MenuItem>
    );
  }
  return (
    <MenuItem onSelect={onSelect}>
      {t('header.rateVisible', { count: asked.items.length })}
    </MenuItem>
  );
}

export interface RateVisibleDialogProps {
  asked: Asked;
  /** What the question calls the view. */
  name: string;
  onClose: () => void;
}

/**
 * "Rate these N visible articles" (spec 09 §3.3): asks first, with the number of articles the list
 * showed when it was opened, then rates just those. It sends no analysis request.
 */
export function RateVisibleDialog({ asked, name, onClose }: RateVisibleDialogProps) {
  const { t } = useTranslation('reader');
  const store = useReaderActions();
  const undo = useUndoAction();
  const toast = useToast();
  const queryClient = useQueryClient();
  const accountId = useAccountId();
  const [pending, setPending] = useState<1 | -1 | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const count = asked.items.length;
  const capped = asked.shown > count;

  async function rate(rating: 1 | -1) {
    setPending(rating);
    setFailure(null);
    const result = await store.bulk({ kind: 'rateBulk', items: asked.items, rating });
    switch (result.status) {
      case 'done': {
        const entry = store.recent().find((recent) => recent.mutationId === result.mutationId);
        toast.show({
          id: TOAST_ID,
          message: t('rateVisible.done', { count: result.count }),
          tone: 'success',
          durationMs: UNDO_TOAST_MS,
          action:
            entry === undefined
              ? undefined
              : { label: t('common:actions.undo'), onAction: () => void undo(entry.id) },
        });
        void queryClient.invalidateQueries({ queryKey: articleKeys.counts(accountId) });
        onClose();
        return;
      }
      case 'stale':
        toast.show({ message: t('article:toast.stale'), tone: 'info' });
        onClose();
        return;
      case 'failed':
        if (result.error.kind === 'aborted') {
          onClose();
          return;
        }
        setFailure(result.error);
        setPending(null);
        return;
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('rateVisible.title', { count })}
      description={
        <div className="flex flex-col gap-2">
          <p>
            {capped
              ? t('rateVisible.bodyFirst', { max: count, view: name })
              : t('rateVisible.body', { count, view: name })}
          </p>
          {capped ? <p>{t('rateVisible.capped', { shown: asked.shown, max: count })}</p> : null}
          <p>{t('rateVisible.notLoaded')}</p>
        </div>
      }
      showCloseButton={false}
      dismissible={pending === null}
    >
      {failure === null ? null : (
        <p
          role="alert"
          className="flex items-start gap-2 text-sm font-medium text-red-700 dark:text-red-300"
        >
          <WarningIcon className="mt-0.5 size-4" />
          {errorMessage(t, failure)}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" disabled={pending !== null} onClick={onClose}>
          {t('common:actions.cancel')}
        </Button>
        <Button loading={pending === -1} disabled={pending !== null} onClick={() => void rate(-1)}>
          {t('rateVisible.dislikeAll')}
        </Button>
        <Button loading={pending === 1} disabled={pending !== null} onClick={() => void rate(1)}>
          {t('rateVisible.likeAll')}
        </Button>
      </div>
    </Dialog>
  );
}
