import type { ArticleListItem, MarkReadLane } from '@bantoozi/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../api/context.js';
import { routes } from '../../api/routes.js';
import { Button } from '../../components/button.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { errorMessage } from '../../components/error-message.js';
import { useToast } from '../../components/toast/toast-provider.js';
import { useAccountId, useMe } from '../../session/context.js';
import { useReaderActions, useUndoAction } from './actions/provider.js';
import { countsQueryOptions } from './queries.js';
import { useReaderTargets } from './reader-state.js';
import { countOf, type ViewScope } from './view.js';

const TOAST_ID = 'reader-mark-all-read';
/** Spec 09 §3.3: the undo toast of a bulk action stays for 5 seconds. */
const UNDO_TOAST_MS = 5000;

/** What the reader is asked to confirm: the number, and the instant and version it was counted at. */
interface Ask {
  count: number;
  asOf: string;
  datasetVersion: string;
  /** The question was asked before and the list changed, so this is a new number. */
  changed: boolean;
}

export interface MarkAllReadProps {
  lane: MarkReadLane;
  scope: ViewScope;
  /** What the question calls the view. */
  name: string;
  /** The unread articles the view has, if known. */
  count: number | undefined;
  /** The articles of the view that are loaded. */
  items: readonly ArticleListItem[];
  /** Called when the articles of the view have changed, to show how they are now. */
  onChanged: () => void;
}

/**
 * "Mark all read" (spec 09 §3.1): asks first, with the number of articles it would mark, then marks
 * the whole view, not only the loaded rows. The server compares the view's `datasetVersion` at the
 * `olderThan` instant with the one the reader confirmed, so the number and the version come from
 * the same instant; a view that changed meanwhile asks again with the new number.
 */
export function MarkAllRead({ lane, scope, name, count, items, onChanged }: MarkAllReadProps) {
  const { t } = useTranslation('reader');
  const api = useApi();
  const queryClient = useQueryClient();
  const accountId = useAccountId();
  const store = useReaderActions();
  const undoAction = useUndoAction();
  const toast = useToast();
  const { defaultTier: minTier } = useMe().preferences;
  const { markAllRead } = useReaderTargets();
  const [ask, setAsk] = useState<Ask | null>(null);
  const [preparing, setPreparing] = useState(false);
  const askingAgain = useRef(false);

  // The `datasetVersion` of the counts is that of `lane = all`. Any other lane has a digest of its
  // own, which only a list of that lane can tell, and the counts at the instant of that list say how
  // many articles it covers.
  async function prepare(): Promise<Omit<Ask, 'changed'>> {
    if (lane === 'all') {
      const counts = await queryClient.fetchQuery(
        countsQueryOptions(api, accountId, scope, minTier),
      );
      return { count: counts.total, asOf: counts.asOf, datasetVersion: counts.datasetVersion };
    }
    const probe = await api.call(routes.articleList, {
      query: { lane, ...scope, minTier, limit: 1 },
    });
    const counts = await api.call(routes.articleCounts, {
      query: { ...scope, minTier, asOf: probe.asOf },
    });
    return {
      count: countOf(counts, lane),
      asOf: probe.asOf,
      datasetVersion: probe.datasetVersion,
    };
  }

  async function open() {
    setPreparing(true);
    try {
      setAsk({ ...(await prepare()), changed: false });
    } catch (error) {
      toast.show({ message: errorMessage(t, error), tone: 'error' });
    } finally {
      setPreparing(false);
    }
  }

  async function confirm() {
    if (ask === null) return;
    const result = await store.bulk({
      kind: 'markReadFilter',
      filter: { lane, ...scope, minTier, olderThan: ask.asOf },
      datasetVersion: ask.datasetVersion,
      items: items.filter((item) => store.view(item).readAt === null),
    });
    switch (result.status) {
      case 'done': {
        const entry = store.recent().find((recent) => recent.mutationId === result.mutationId);
        toast.show({
          id: TOAST_ID,
          message: t('markAll.done', { count: result.count }),
          tone: 'success',
          durationMs: UNDO_TOAST_MS,
          action:
            entry === undefined
              ? undefined
              : { label: t('common:actions.undo'), onAction: () => void undoAction(entry.id) },
        });
        onChanged();
        return;
      }
      case 'stale':
        setAsk({ ...(await prepare()), changed: true });
        // The dialog closes itself once this returns; this one stays, with the new number.
        askingAgain.current = true;
        return;
      case 'failed': {
        const { error } = result;
        if (error.kind === 'aborted') return;
        const max = error.details?.['max'];
        toast.show({
          message:
            error.reason === 'too_many_targets' && typeof max === 'number'
              ? t('markAll.tooMany', { max })
              : errorMessage(t, error),
          tone: 'error',
        });
        return;
      }
    }
  }

  function close() {
    if (askingAgain.current) {
      askingAgain.current = false;
      return;
    }
    setAsk(null);
  }

  const disabled = count === undefined || count === 0;
  // The Shift+A shortcut asks as the button does, and only while the button could be pressed.
  useEffect(() => {
    markAllRead.current = disabled || preparing ? null : () => void open();
    return () => {
      markAllRead.current = null;
    };
  });

  return (
    <>
      <Button
        variant="secondary"
        disabled={disabled}
        loading={preparing}
        onClick={() => void open()}
      >
        {t('header.markAll')}
      </Button>
      <ConfirmDialog
        open={ask !== null}
        onClose={close}
        onConfirm={confirm}
        title={t('markAll.title')}
        confirmLabel={t('markAll.confirm')}
        body={
          ask === null ? undefined : (
            <div className="flex flex-col gap-2">
              <p>{t('markAll.body', { count: ask.count, view: name })}</p>
              {ask.changed ? <p>{t('markAll.changed')}</p> : null}
            </div>
          )
        }
      />
    </>
  );
}
