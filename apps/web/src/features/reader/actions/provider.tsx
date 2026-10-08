import { DEFAULT_USER_PREFERENCES, type ArticleListItem, type Me } from '@bantoozi/shared';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { i18n as I18n } from 'i18next';
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
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
import type { ToastAction, ToastInput } from '../../../components/toast/toast-store.js';
import { onAccountReset } from '../../../session/reset.js';
import { createReturnTracker, type ReturnTracker } from '../../article/dwell.js';
import { createExampleOffers } from '../../article/example-offer.js';
import { articleKeys } from '../../article/query-keys.js';
import { createReasonBar, type ReasonBar } from '../../article/reason-bar-store.js';
import { createReaderActions } from './store.js';
import { createReaderTransport } from './transport.js';
import type {
  ActionHandle,
  ActionResult,
  ExampleSuggestion,
  ReaderAction,
  ReaderActions,
  UndoResult,
} from './types.js';

const UNDO_TOAST_ID = 'reader-undo';
/** Spec 09 §3.3: the undo toast after a rating stays for 5 seconds. */
const UNDO_TOAST_MS = 5000;
/** Spec 09 §3.3: the undo toast that carries an example suggestion stays for 8 seconds. */
const OFFER_TOAST_MS = 8000;
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

/** Hears each settled action of the account, after the provider has shown its own toasts. */
export type SettledListener = (handle: ActionHandle, result: ActionResult) => void;

/** What one signed-in account owns: its reader action store, dwell tracker and reason bar. */
interface Scope {
  readonly store: ReaderActions;
  readonly tracker: ReturnTracker;
  readonly reasonBar: ReasonBar;
  /** Adds a listener for settled actions and returns its removal. */
  listen(listener: SettledListener): () => void;
  /** Undoes an acknowledged action by its receipt and says so when that is not possible. */
  undo(actionId: string): Promise<UndoResult>;
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
  const listeners = new Set<SettledListener>();
  /** Counts the rating toasts asked for: an offer that comes after a newer toast is dropped. */
  let latestOffer = 0;

  /** Shows the toast and remembers it, so that an account reset takes it away. */
  const tracked: Pick<ToastApi, 'show'> = {
    show(input) {
      const id = toast.show(input);
      toastIds.add(id);
      return id;
    },
  };

  function show(input: ToastInput): void {
    tracked.show(input);
  }

  const offers = createExampleOffers({ api, queryClient, toast: tracked, i18n, accountId });

  async function undo(actionId: string): Promise<UndoResult> {
    const result = await store.undo(actionId);
    switch (result.status) {
      case 'conflict':
        show({ message: i18n.t('article:toast.undoConflict'), tone: 'info' });
        break;
      case 'refused':
        show({ message: i18n.t('article:toast.undoRefused'), tone: 'info' });
        break;
      case 'failed':
        if (result.error.kind !== 'aborted') {
          show({ message: errorMessage(i18n.t, result.error), tone: 'error' });
        }
        break;
      case 'undone':
      case 'cancelled':
        break;
    }
    return result;
  }

  const isRecent = (handle: ActionHandle) => store.recent().some((entry) => entry.id === handle.id);

  function offerUndo(handle: ActionHandle, suggestion: ExampleSuggestion | null): void {
    const { action } = handle;
    if (action.type !== 'rate') return;
    if (!isRecent(handle)) return;
    latestOffer += 1;
    const turn = latestOffer;
    const message = ratingMessage(i18n, action.rating);
    const undoAction: ToastAction = {
      label: i18n.t('common:actions.undo'),
      onAction: () => {
        void undo(handle.id);
      },
    };
    const showPlain = () => {
      show({
        id: UNDO_TOAST_ID,
        message,
        tone: 'success',
        durationMs: UNDO_TOAST_MS,
        action: undoAction,
      });
    };
    if (suggestion === null || !preferences().exampleSuggestions) {
      showPlain();
      return;
    }
    void offers.actionsFor(suggestion, handle.articleId).then((offered) => {
      if (turn !== latestOffer || !isRecent(handle)) return;
      if (offered === null) {
        showPlain();
        return;
      }
      show({
        id: UNDO_TOAST_ID,
        message,
        tone: 'success',
        durationMs: OFFER_TOAST_MS,
        action: undoAction,
        actions: offered,
      });
    });
  }

  function showOutcome(handle: ActionHandle, result: ActionResult): void {
    switch (result.status) {
      case 'done':
        void queryClient.invalidateQueries({ queryKey: articleKeys.counts(accountId) });
        offerUndo(handle, result.exampleSuggestion);
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

  function onSettled(handle: ActionHandle, result: ActionResult): void {
    showOutcome(handle, result);
    for (const listener of [...listeners]) listener(handle, result);
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
  const reasonBar = createReasonBar(store);

  return {
    store,
    tracker,
    reasonBar,
    undo,
    listen(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    release() {
      latestOffer += 1;
      offers.release();
      reasonBar.close();
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

/**
 * Undo by receipt for the surfaces that offer it besides the rating toast (spec 09 §3.3: the
 * recent-action menu, bulk actions). It shows why an undo did not go through; the result says
 * what happened, for a caller that has more to refresh.
 */
export function useUndoAction(): (actionId: string) => Promise<UndoResult> {
  return useScope().undo;
}

/** The reason bar of the account: it holds a dislike until its reason is chosen (spec 09 §3.3). */
export function useReasonBar(): ReasonBar {
  return useScope().reasonBar;
}

/** The tracker that reports the time away after "Read original". */
export function useReturnTracker(): ReturnTracker {
  return useScope().tracker;
}

/**
 * Calls `listener` with each settled action of the account while the component is mounted, for
 * what follows an answer: a dwell's prompt (spec 09 §3.6). A rating's example suggestion is
 * offered by the provider itself, in the undo toast.
 */
export function useSettledActions(listener: SettledListener): void {
  const { listen } = useScope();
  const latest = useRef(listener);
  useLayoutEffect(() => {
    latest.current = listener;
  });
  useEffect(
    () =>
      listen((handle, result) => {
        latest.current(handle, result);
      }),
    [listen],
  );
}
