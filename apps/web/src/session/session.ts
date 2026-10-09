import type { Me, RequestCodeResponse } from '@bantoozi/shared';
import { hashKey, isCancelledError, type QueryClient } from '@tanstack/react-query';
import type { i18n as I18n } from 'i18next';

import { createApiClient, type ApiClient } from '../api/client.js';
import { isApiError, isRetryable } from '../api/errors.js';
import { meKey } from '../api/query-keys.js';
import { routes } from '../api/routes.js';
import { clearAccount, finishPendingPurges, readMe, saveMe } from '../offline/cache.js';
import {
  clearLastAccount,
  clearLogoutPending,
  isLogoutPending,
  isOfflineEnabled,
  markLogoutPending,
  readLastAccount,
  writeLastAccount,
} from '../offline/device.js';
import { clearAccountKeys, forgetAccountMemory } from './local-keys.js';
import { meQueryOptions } from './me.js';
import { OfflineStartupError } from './offline-start.js';
import { runResetHooks, type ResetReason } from './reset.js';

/** Tabs of one browser tell each other here that the account state was dropped. */
export const SESSION_CHANNEL = 'bantoozi:session';

const ME_HASH = hashKey(meKey());

/** The first wait before a refused sign-out is sent again; it doubles after each failure. */
const LOGOUT_RETRY_FIRST_MS = 2_000;
/** The longest wait between two tries. */
const LOGOUT_RETRY_MAX_MS = 5 * 60_000;

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

export interface LogoutResult {
  /**
   * False when the server could not be reached: the device is signed out, the session of the
   * server is ended as soon as the connection is back.
   */
  serverSignedOut: boolean;
}

export interface Session {
  /** The app's client: a 401 on any of its calls ends the session. */
  readonly api: ApiClient;
  /**
   * The signed-in account or null, for the router context. Without a connection it is the account
   * that chose offline reading, for 24 hours; otherwise it throws `OfflineStartupError`.
   */
  loadMe: () => Promise<Me | null>;
  requestCode: (input: RequestCodeInput) => Promise<RequestCodeResponse>;
  /** Signs in. An account other than the one this device knew drops the old one's state first. */
  verifyCode: (input: { email: string; code: string }) => Promise<Me>;
  /**
   * Drops the state of the device and ends the server session. Without a connection (or after a
   * 5xx or 429) the device is signed out at once and the server session is ended later.
   * Navigating away is up to the caller.
   */
  logout: () => Promise<LogoutResult>;
  /** Drops everything private: the query cache, the registered stores, the other tabs' memory. */
  resetAccountState: () => Promise<void>;
  /** Ends the session after a 401 that did not come through `api`, such as the streamed export. */
  unauthorized: () => void;
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

  // The account of the last `Me` seen, from an earlier visit of the page too. Unlike the cache it
  // survives a 401, so signing back in as the same account is not a switch while signing in as
  // another one is.
  let knownAccountId: string | undefined = readLastAccount()?.id;
  // undefined until the first answer: learning who is signed in at startup is not a change.
  let signedInId = idInCache();
  // True while the saved account is put back in the cache, which must not renew its 24 hours.
  let restoring = false;
  // The removal of the previous account's data after another account arrived.
  let switching: Promise<void> | null = null;
  let finishing: Promise<void> | null = null;
  let logoutRetry: ReturnType<typeof setTimeout> | undefined;
  let logoutFailures = 0;
  let disposed = false;

  function idInCache(): string | null | undefined {
    const me = queryClient.getQueryData<Me | null>(meKey());
    return me === undefined ? undefined : (me?.id ?? null);
  }

  function applyLocale(me: Me) {
    document.documentElement.lang = me.locale;
    if (i18n.language !== me.locale) void i18n.changeLanguage(me.locale);
  }

  /**
   * Keeps the account for an offline start. What a sign-out could not remove from the device goes
   * first: until it is gone, nothing of that account can be stored or read.
   */
  async function keepForOffline(me: Me) {
    await finishPendingPurges();
    await saveMe(me.id, me);
  }

  function meChanged(me: Me | null) {
    if (me !== null) {
      const previousAccountId = knownAccountId;
      knownAccountId = me.id;
      applyLocale(me);
      if (!restoring) {
        writeLastAccount(me.id);
        void keepForOffline(me);
      }
      // A `/me` answer for another account (a window that shares the cookie but not the channel
      // signed in): the old account's data goes before the new one is shown.
      if (previousAccountId !== undefined && previousAccountId !== me.id) {
        const removal = Promise.resolve().then(async () => {
          await reset('account_switch', previousAccountId);
          queryClient.setQueryData(meKey(), me);
        });
        switching = removal;
        void removal.finally(() => {
          if (switching === removal) switching = null;
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

  /** What leaves the device with the account: nothing on a 401, only memory for another tab's reset. */
  async function removeFromDevice(reason: ResetReason, accountId: string | undefined) {
    if (reason === 'logout') clearLastAccount();
    if (accountId === undefined || reason === 'unauthorized') return;
    if (reason === 'remote') {
      forgetAccountMemory(accountId);
      return;
    }
    clearAccountKeys(accountId);
    await clearAccount(accountId);
  }

  function reset(reason: ResetReason, accountId: string | undefined = knownAccountId) {
    queryClient.clear();
    queryClient.setQueryData(meKey(), null);
    if (reason === 'logout' || reason === 'remote') knownAccountId = undefined;
    const hooksDone = runResetHooks(reason);
    const removed = removeFromDevice(reason, accountId);
    if (reason !== 'remote') channel?.postMessage({ type: 'reset' });
    return Promise.all([hooksDone, removed]).then(() => undefined);
  }

  // The answer 401 of the `/me` probe itself arrives while nobody is known yet: nothing to drop.
  function handleUnauthorized() {
    if (queryClient.getQueryData<Me | null>(meKey())) void reset('unauthorized');
  }

  async function endServerSession(): Promise<void> {
    try {
      await api.call(routes.authLogout);
    } catch (error) {
      // Already signed out is the state we are after.
      if (!isApiError(error) || error.status !== 401) throw error;
    }
  }

  /** Ends the server session of a sign-out that was made without a connection. */
  function finishPendingLogout(): Promise<void> {
    if (!isLogoutPending()) return Promise.resolve();
    finishing ??= endServerSession()
      .then(() => {
        clearTimeout(logoutRetry);
        logoutFailures = 0;
        clearLogoutPending();
      })
      .finally(() => {
        finishing = null;
      });
    return finishing;
  }

  /**
   * Sends a sign-out the server refused for now (network, 5xx, 429) again while the browser reports
   * a connection: a server that answers again sends no `online` event. The wait doubles up to five
   * minutes and is never shorter than the server's Retry-After (spec 09 §1).
   */
  function retryLogoutLater(error: unknown) {
    clearTimeout(logoutRetry);
    if (disposed || !isRetryable(error) || navigator.onLine === false) return;
    const backoff = Math.min(LOGOUT_RETRY_FIRST_MS * 2 ** logoutFailures, LOGOUT_RETRY_MAX_MS);
    logoutFailures += 1;
    const asked = isApiError(error) ? (error.retryAfterMs ?? 0) : 0;
    logoutRetry = setTimeout(finishQuietly, Math.max(backoff, asked));
  }

  function finishQuietly() {
    finishPendingLogout().catch(retryLogoutLater);
  }

  window.addEventListener('online', finishQuietly);
  if (navigator.onLine !== false) finishQuietly();
  // What an earlier sign-out could not remove from the device goes now.
  void finishPendingPurges();

  async function restoreOffline(cause: unknown): Promise<Me> {
    const last = readLastAccount();
    const saved = last !== null && isOfflineEnabled(last.id) ? await readMe(last.id) : null;
    if (saved === null) throw new OfflineStartupError({ cause });
    restoring = true;
    try {
      queryClient.setQueryData(meKey(), saved.me);
    } finally {
      restoring = false;
    }
    return saved.me;
  }

  async function loadMe(): Promise<Me | null> {
    // Someone signed out without a connection: nobody is signed in, whatever the server still says.
    if (isLogoutPending()) return null;
    await switching;
    try {
      const me = await queryClient.ensureQueryData(meQuery);
      await switching;
      return me;
    } catch (error) {
      // A reset removes the query being fetched and leaves the signed-out answer in its place.
      if (isCancelledError(error)) return queryClient.getQueryData<Me | null>(meKey()) ?? null;
      if (isApiError(error) && error.kind === 'network') return restoreOffline(error);
      throw error;
    }
  }

  async function verifyCode(input: { email: string; code: string }): Promise<Me> {
    await finishPendingLogout();
    const { user } = await api.call(routes.authVerify, { body: input });
    if (knownAccountId !== undefined && knownAccountId !== user.id) {
      await reset('account_switch', knownAccountId);
    }
    knownAccountId = user.id;
    queryClient.setQueryData(meKey(), user);
    return user;
  }

  async function logout(): Promise<LogoutResult> {
    const accountId = knownAccountId;
    let refused: unknown = null;
    try {
      await api.call(routes.authLogout);
    } catch (error) {
      // Already signed out is the state we are after.
      if (!isApiError(error) || error.status !== 401) {
        if (!isRetryable(error)) throw error;
        refused = error;
      }
    }
    if (refused !== null) markLogoutPending();
    await reset('logout', accountId);
    if (refused !== null) retryLogoutLater(refused);
    return { serverSignedOut: refused === null };
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
    unauthorized: handleUnauthorized,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      disposed = true;
      stopWatchingCache();
      clearTimeout(logoutRetry);
      window.removeEventListener('online', finishQuietly);
      channel?.close();
      listeners.clear();
    },
  };
}
