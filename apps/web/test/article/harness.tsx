import type { ArticleDetail, ArticleListItem, LabelDto, Me } from '@bantoozi/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';

import { createApiClient } from '../../src/api/client.js';
import { ApiProvider } from '../../src/api/context.js';
import { meKey } from '../../src/api/query-keys.js';
import { ToastProvider } from '../../src/components/toast/toast-provider.js';
import { Toaster } from '../../src/components/toast/toaster.js';
import { createToastStore } from '../../src/components/toast/toast-store.js';
import { ReasonBar } from '../../src/features/article/reason-bar.js';
import { forgetCardMoves } from '../../src/features/interests/card-moves.js';
import { ReaderActionsProvider } from '../../src/features/reader/actions/provider.js';
import { createI18n, type Language } from '../../src/i18n/index.js';
import { SessionProvider } from '../../src/session/context.js';
import type { Session } from '../../src/session/session.js';
import { fakeFetch, json, type RecordedRequest } from '../api/fake-fetch.js';
import { makeItem } from '../reader/actions/fake-transport.js';
import { makeMe } from '../session/fixtures.js';
import { bodyOf, createFakeServer, type ApiRouteHandler } from '../support/app.js';

export { bodyOf, makeItem, makeMe };

export const MUTATION_ID = '5b0f1a54-2d1c-4a53-9d7e-3b1f6c1e9a10';
export const UNDO_MUTATION_ID = 'c2d6a0b8-47f1-4f0e-8d57-0e0c4c5d7b21';

export interface ReaderHarnessOptions {
  me?: Me;
  language?: Language;
  routes?: Record<string, ApiRouteHandler>;
}

/**
 * Renders `ui` the way the signed-in app does: the typed API client over a fake `fetch`, the query
 * cache with the account already known, toasts, the reader action provider and the reason bar.
 */
export function renderReader(ui: ReactNode, options: ReaderHarnessOptions = {}) {
  forgetCardMoves();
  const me = options.me ?? makeMe();
  const fake = createFakeServer({ me, routes: options.routes ?? {} });
  const fetched = fakeFetch(fake.handler);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(meKey(), me);
  const api = createApiClient({ fetch: fetched.fetch });
  const toasts = createToastStore();
  const i18n = createI18n(options.language ?? 'en');
  let accountId = me.id;
  // The session as far as these screens use it: which sign-in lasts, a new one at each sign-in.
  let signIns = 0;
  const session = { currentSignIn: () => signIns } as Partial<Session> as Session;
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <ApiProvider client={api}>
            <SessionProvider session={session}>
              <ToastProvider store={toasts}>
                <ReaderActionsProvider accountId={accountId}>
                  {children}
                  <ReasonBar />
                </ReaderActionsProvider>
                <Toaster />
              </ToastProvider>
            </SessionProvider>
          </ApiProvider>
        </QueryClientProvider>
      </I18nextProvider>
    );
  }
  const user = userEvent.setup();
  const view = render(ui, { wrapper: Wrapper });
  return {
    ...view,
    user,
    queryClient,
    toasts,
    requests: fetched.requests,
    unhandled: fake.unhandled,
    /** Requests that were made to one operation, e.g. `calls('POST', '/articles/101/rating')`. */
    calls: (method: string, path: string): RecordedRequest[] =>
      fetched.requests.filter(
        (request) => request.method === method && request.pathname === `/api/v1${path}`,
      ),
    /** Mounts the reader provider again for another account, as signing in as someone else does. */
    switchAccount: (id: string) => {
      accountId = id;
      signIns += 1;
      view.rerender(ui);
    },
    /** Signs out and in again as `next`, which may be the same account. */
    signInAgain: (next: Me) => {
      signIns += 1;
      act(() => {
        queryClient.setQueryData(meKey(), next);
      });
    },
  };
}

/** A valid `ArticleDetail`: the list item plus the extras of `GET /articles/:id`. */
export function makeDetail(
  item: ArticleListItem,
  overrides: Partial<ArticleDetail> = {},
): ArticleDetail {
  return {
    ...item,
    excerptHtml: '<p>The excerpt of the article.</p>',
    bodyLead: null,
    explain: null,
    translation: null,
    clusterMembers: [],
    bookmarkSnapshot: null,
    ...overrides,
  };
}

export function makeLabel(id: string, name: string, color = '#64748b'): LabelDto {
  return {
    id,
    name,
    color,
    definition: `Articles about ${name}`,
    notFor: null,
    examplesYes: [],
    examplesNo: [],
    count: 0,
  };
}

/** `GET /labels` answering with these labels. */
export function labelRoute(...labels: LabelDto[]): Record<string, ApiRouteHandler> {
  return { 'GET /labels': () => json(200, labels) };
}

/** `GET /articles/:id` answering with the detail of `item`. */
export function detailRoute(
  item: ArticleListItem,
  overrides: Partial<ArticleDetail> = {},
): Record<string, ApiRouteHandler> {
  return { 'GET /articles/:id': () => json(200, makeDetail(item, overrides)) };
}

/** The answer of an action route: the new item and the receipt. */
export function actionResponse(item: ArticleListItem, extra: Record<string, unknown> = {}) {
  return json(200, { item, mutationId: MUTATION_ID, ...extra });
}

/** The answer of `POST /articles/:id/rating`. */
export function ratingResponse(item: ArticleListItem) {
  return actionResponse(item, { exampleSuggestion: null });
}

/** The answer of `POST /articles/undo`. */
export function undoResponse(...items: ArticleListItem[]) {
  return json(200, { count: items.length, mutationId: UNDO_MUTATION_ID, items });
}

/** A valid rule, as `POST /rules` and `POST /articles/:id/mute-story` return it. */
export function makeRule(id: string, kind: string, value: string, displayValue = value) {
  return {
    id,
    kind,
    value,
    displayValue,
    createdAt: '2026-05-31T10:00:00.000Z',
    expiresAt: null,
  };
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

/** A promise the test settles by hand, to hold a fake server answer back. */
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** The toast showing `message` (waits for it). */
export async function findToast(message: string | RegExp): Promise<HTMLElement> {
  const text = await screen.findByText(message);
  const toast = text.closest('[data-tone]');
  if (!(toast instanceof HTMLElement)) throw new Error(`"${String(message)}" is not in a toast`);
  return toast;
}

/** Makes the page hidden or visible and tells the listeners, as a browser does when the tab changes. */
export function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

export function restoreVisibility(): void {
  Reflect.deleteProperty(document, 'visibilityState');
}
