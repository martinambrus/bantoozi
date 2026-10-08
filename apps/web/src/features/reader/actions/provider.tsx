import { DEFAULT_USER_PREFERENCES, type ArticleListItem, type Me } from '@bantoozi/shared';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { i18n as I18n } from 'i18next';
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';

import type { ApiClient } from '../../../api/client.js';
import { useApi } from '../../../api/context.js';
import { meKey } from '../../../api/query-keys.js';
import { errorMessage } from '../../../components/error-message.js';
import { useToast, type ToastApi } from '../../../components/toast/toast-provider.js';
import type { ToastInput } from '../../../components/toast/toast-store.js';
import { onAccountReset } from '../../../session/reset.js';
import { createReturnTracker, type ReturnTracker } from '../../article/dwell.js';
import { articleKeys } from '../../article/query-keys.js';
import { createReaderActions } from './store.js';
import { createReaderTransport } from './transport.js';
import type { ActionHandle, ActionResult, ReaderAction, ReaderActions } from './types.js';

const UNDO_TOAST_ID = 'reader-undo';
/** Spec 09 §3.3: the undo toast after a rating stays for 5 seconds. */
const UNDO_TOAST_MS = 5000;
const FAILED_TOAST_MS = 8000;

/** The reader did not ask for these (spec 09 §3.6), so their failure is not shown to them. */
const IMPLICIT_ACTIONS: ReadonlySet<ReaderAction['type']> = new Set(['open', 'dwell']);

interface Environment {
  api: ApiClient;
  queryClient: QueryClient;
  toast: ToastApi;
  i18n: I18n;
  accountId: string;
}

/** What one signed-in account owns: the store of its reader actions and the dwell tracker. */
interface Scope {
  readonly store: ReaderActions;
  readonly tracker: ReturnTracker;
  /** Aborts what is in flight and forgets everything, toasts that offer to act on it included. */
  release(): void;
}

function ratingMessage(i18n: I18n, rating: 1 | -1 | null): string {
  switch (rating) {
    case 1:
      return i18n.t('article:toast.ratedUp');
    case -1:
      return i18n.t('article:toast.ratedDown');
    case null:
      return i18n.t('article:toast.ratingRemoved');
  }
}

function createScope({ api, queryClient, toast, i18n, accountId }: Environment): Scope {
  const toastIds = new Set<string>();

  function show(input: ToastInput): void {
    toastIds.add(toast.show(input));
  }

  async function undo(actionId: string): Promise<void> {
    const result = await store.undo(actionId);
    switch (result.status) {
      case 'conflict':
        show({ message: i18n.t('article:toast.undoConflict'), tone: 'info' });
        return;
      case 'refused':
        show({ message: i18n.t('article:toast.undoRefused'), tone: 'info' });
        return;
      case 'failed':
        if (result.error.kind !== 'aborted') {
          show({ message: errorMessage(i18n.t, result.error), tone: 'error' });
        }
        return;
      case 'undone':
      case 'cancelled':
        return;
    }
  }

  function offerUndo(handle: ActionHandle): void {
    const { action } = handle;
    if (action.type !== 'rate') return;
    if (!store.recent().some((entry) => entry.id === handle.id)) return;
    show({
      id: UNDO_TOAST_ID,
      message: ratingMessage(i18n, action.rating),
      tone: 'success',
      durationMs: UNDO_TOAST_MS,
      action: {
        label: i18n.t('common:actions.undo'),
        onAction: () => {
          void undo(handle.id);
        },
      },
    });
  }

  function onSettled(handle: ActionHandle, result: ActionResult): void {
    switch (result.status) {
      case 'done':
        void queryClient.invalidateQueries({ queryKey: articleKeys.counts(accountId) });
        offerUndo(handle);
        return;
      case 'failed':
        if (IMPLICIT_ACTIONS.has(handle.action.type)) return;
        show({
          id: `save-failed:${handle.id}`,
          message: i18n.t('common:toast.saveFailed'),
          tone: 'error',
          durationMs: FAILED_TOAST_MS,
          action: {
            label: i18n.t('common:actions.retry'),
            onAction: () => {
              store.retry(handle.id);
            },
          },
        });
        return;
      case 'stale':
        if (IMPLICIT_ACTIONS.has(handle.action.type)) return;
        show({ message: i18n.t('article:toast.stale'), tone: 'info' });
        return;
      case 'cancelled':
        return;
    }
  }

  const preferences = () =>
    queryClient.getQueryData<Me | null>(meKey())?.preferences ?? DEFAULT_USER_PREFERENCES;
  const store = createReaderActions({
    transport: createReaderTransport(api),
    preferences,
    onSettled,
  });
  const tracker = createReturnTracker({
    store,
    implicitFeedback: () => preferences().implicitFeedback,
  });

  return {
    store,
    tracker,
    release() {
      store.reset();
      tracker.clear();
      for (const id of toastIds) toast.dismiss(id);
      toastIds.clear();
    },
  };
}

/**
 * The scope is made by the first component that asks for it, because only those components are
 * known to sit below the API, query and toast providers; the provider itself needs none of them.
 */
interface Holder {
  readonly accountId: string;
  scope: Scope | null;
}

const HolderContext = createContext<Holder | null>(null);

export interface ReaderActionsProviderProps {
  accountId: string;
  children: ReactNode;
}

function AccountScope({ accountId, children }: ReaderActionsProviderProps) {
  const [holder] = useState<Holder>(() => ({ accountId, scope: null }));

  useEffect(() => {
    const unregister = onAccountReset(() => {
      holder.scope?.release();
    });
    return () => {
      unregister();
      holder.scope?.release();
    };
  }, [holder]);

  return <HolderContext value={holder}>{children}</HolderContext>;
}

/**
 * One reader action store per signed-in account (spec 09 §1, §3.3): everything below shares its
 * optimistic state, and an account reset or another account drops it. Another account remounts
 * everything below, so no state of the old one is shown for the new one.
 */
export function ReaderActionsProvider({ accountId, children }: ReaderActionsProviderProps) {
  return (
    <AccountScope key={accountId} accountId={accountId}>
      {children}
    </AccountScope>
  );
}

function useScope(): Scope {
  const holder = useContext(HolderContext);
  const api = useApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { i18n } = useTranslation();
  if (holder === null) {
    throw new Error('The reader actions need a <ReaderActionsProvider> above them');
  }
  holder.scope ??= createScope({ api, queryClient, toast, i18n, accountId: holder.accountId });
  return holder.scope;
}

/** The reader's single write path (`dispatch`, `undo`, `retry`, …) of the signed-in account. */
export function useReaderActions(): ReaderActions {
  return useScope().store;
}

/** `item` as the reader should see it: optimistic changes included, and it follows the store. */
export function useReaderItem<T extends ArticleListItem>(item: T): T {
  const { store } = useScope();
  const read = () => store.view(item);
  return useSyncExternalStore(store.subscribe, read, read);
}

/** Tells the store what the server says about these articles. Pass a stable array. */
export function useObserveItems(items: readonly ArticleListItem[]): void {
  const { store } = useScope();
  useLayoutEffect(() => {
    store.observe(items);
  }, [store, items]);
}

/** The tracker that reports the time away after "Read original". */
export function useReturnTracker(): ReturnTracker {
  return useScope().tracker;
}
