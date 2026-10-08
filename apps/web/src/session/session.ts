import type { Me, RequestCodeResponse } from '@bantoozi/shared';
import { hashKey, isCancelledError, type QueryClient } from '@tanstack/react-query';
import type { i18n as I18n } from 'i18next';

import { createApiClient, type ApiClient } from '../api/client.js';
import { isApiError } from '../api/errors.js';
import { meKey } from '../api/query-keys.js';
import { routes } from '../api/routes.js';
import { meQueryOptions } from './me.js';
import { runResetHooks, type ResetReason } from './reset.js';

/** Tabs of one browser tell each other here that the account state was dropped. */
export const SESSION_CHANNEL = 'bantoozi:session';

const ME_HASH = hashKey(meKey());

export interface SessionOptions {
  queryClient: QueryClient;
  i18n: Pick<I18n, 'language' | 'changeLanguage'>;
  fetch?: typeof fetch | undefined;
}

export interface RequestCodeInput {
  email: string;
  inviteCode?: string | undefined;
  locale: string;
}

export interface Session {
  /** The app's client: a 401 on any of its calls ends the session. */
  readonly api: ApiClient;
  /** The signed-in account or null, for the router context. */
  loadMe: () => Promise<Me | null>;
  requestCode: (input: RequestCodeInput) => Promise<RequestCodeResponse>;
  /** Signs in. An account other than the one this device knew drops the old one's state first. */
  verifyCode: (input: { email: string; code: string }) => Promise<Me>;
  /** Ends the server session, then drops the state. Navigating away is up to the caller. */
  logout: () => Promise<void>;
  /** Drops everything private: the query cache, the registered stores, the other tabs' memory. */
  resetAccountState: () => Promise<void>;
  /** Calls `listener` when someone signs in or out; returns the function that stops it. */
  subscribe: (listener: () => void) => () => void;
  dispose: () => void;
}

function isResetMessage(data: unknown): boolean {
  return typeof data === 'object' && data !== null && 'type' in data && data.type === 'reset';
}

/**
 * Who is signed in (spec 09 §1, §2). The account lives in the query cache under `meKey()`; this
 * keeps it and the rest of the private state consistent as sessions begin and end.
 */
export function createSession(options: SessionOptions): Session {
  const { queryClient, i18n } = options;
  const api = createApiClient({ fetch: options.fetch, onUnauthorized: handleUnauthorized });
  const meQuery = meQueryOptions(api);
  const listeners = new Set<() => void>();
  const channel =
    typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(SESSION_CHANNEL);

  // The account of the last `Me` seen. Unlike the cache it survives a 401, so signing back in as
  // the same account is not a switch while signing in as another one is.
  let knownAccountId: string | undefined;
  // undefined until the first answer: learning who is signed in at startup is not a change.
  let signedInId = idInCache();

  function idInCache(): string | null | undefined {
    const me = queryClient.getQueryData<Me | null>(meKey());
    return me === undefined ? undefined : (me?.id ?? null);
  }

  function applyLocale(me: Me) {
    document.documentElement.lang = me.locale;
    if (i18n.language !== me.locale) void i18n.changeLanguage(me.locale);
  }

  function meChanged(me: Me | null) {
    if (me !== null) {
      const previousAccountId = knownAccountId;
      knownAccountId = me.id;
      applyLocale(me);
      // A `/me` answer for another account (a window that shares the cookie but not the channel
      // signed in): the old account's state goes before the new one is shown.
      if (previousAccountId !== undefined && previousAccountId !== me.id) {
        queueMicrotask(() => {
          void reset('account_switch');
          queryClient.setQueryData(meKey(), me);
        });
      }
    }
    const id = me?.id ?? null;
    const previous = signedInId;
    signedInId = id;
    if (previous !== undefined && previous !== id) listeners.forEach((listener) => listener());
  }

  const stopWatchingCache = queryClient.getQueryCache().subscribe((event) => {
    if (event.type === 'updated' && event.action.type === 'success') {
      if (event.query.queryHash === ME_HASH) meChanged(event.query.state.data as Me | null);
    }
  });

  if (channel !== null) {
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (isResetMessage(event.data)) void reset('remote');
    };
  }

  function reset(reason: ResetReason): Promise<void> {
    queryClient.clear();
    queryClient.setQueryData(meKey(), null);
    if (reason === 'logout' || reason === 'remote') knownAccountId = undefined;
    const hooksDone = runResetHooks(reason);
    if (reason !== 'remote') channel?.postMessage({ type: 'reset' });
    return hooksDone;
  }

  // The answer 401 of the `/me` probe itself arrives while nobody is known yet: nothing to drop.
  function handleUnauthorized() {
    if (queryClient.getQueryData<Me | null>(meKey())) void reset('unauthorized');
  }

  async function loadMe(): Promise<Me | null> {
    try {
      return await queryClient.ensureQueryData(meQuery);
    } catch (error) {
      // A reset removes the query being fetched and leaves the signed-out answer in its place.
      if (isCancelledError(error)) return queryClient.getQueryData<Me | null>(meKey()) ?? null;
      throw error;
    }
  }

  async function verifyCode(input: { email: string; code: string }): Promise<Me> {
    const { user } = await api.call(routes.authVerify, { body: input });
    if (knownAccountId !== undefined && knownAccountId !== user.id) await reset('account_switch');
    knownAccountId = user.id;
    queryClient.setQueryData(meKey(), user);
    return user;
  }

  async function logout(): Promise<void> {
    try {
      await api.call(routes.authLogout);
    } catch (error) {
      // Already signed out is the state we are after.
      if (!isApiError(error) || error.status !== 401) throw error;
    }
    await reset('logout');
  }

  return {
    api,
    loadMe,
    requestCode: ({ email, inviteCode, locale }) =>
      api.call(routes.authRequestCode, {
        body: { email, locale, ...(inviteCode ? { inviteCode } : {}) },
      }),
    verifyCode,
    logout,
    resetAccountState: () => reset('logout'),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      stopWatchingCache();
      channel?.close();
      listeners.clear();
    },
  };
}
