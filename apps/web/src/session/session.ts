import { MeSchema, type Me, type RequestCodeResponse } from '@bantoozi/shared';
import { hashKey, isCancelledError, type QueryClient } from '@tanstack/react-query';
import type { i18n as I18n } from 'i18next';

import { createApiClient, type ApiClient } from '../api/client.js';
import { isApiError, isRetryable } from '../api/errors.js';
import { meKey } from '../api/query-keys.js';
import { retryLaterMs } from '../api/retry-later.js';
import { routes } from '../api/routes.js';
import {
  clearAccount,
  clearedElsewhere,
  finishPendingPurges,
  readMe,
  saveMe,
} from '../offline/cache.js';
import {
  clearLastAccount,
  clearLogoutPending,
  isLogoutPending,
  isOfflineEnabled,
  markLogoutPending,
  readLastAccount,
  writeLastAccount,
  writeOfflineEnabled,
} from '../offline/device.js';
import { clearAccountKeys, forgetAccountMemory } from './local-keys.js';
import { meQueryOptions } from './me.js';
import { OfflineStartupError } from './offline-start.js';
import { runResetHooks, type ResetReason } from './reset.js';

/** Tabs of one browser tell each other here that the account state was dropped. */
export const SESSION_CHANNEL = 'bantoozi:session';

/** The Web Lock a tab holds while it ends a pending sign-out or signs in. */
const SIGN_IN_LOCK = 'bantoozi:sign-in';

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

export interface LogoutResult {
  /**
   * What became of the server session; the device is signed out whatever it is. `pending`: the
   * server could not be reached (network, 5xx, 429), and the sign-out is sent again as soon as it
   * can be. `refused`: it refused for another reason, and is asked again at the next start.
   */
  server: 'signed_out' | 'pending' | 'refused';
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
  /**
   * Signs in once no sign-out of any tab is on its way. An account other than the one this device
   * knew drops the old one's state first. The other tabs are told: one that shows another account
   * takes this one.
   */
  verifyCode: (input: { email: string; code: string }) => Promise<Me>;
  /**
   * Drops the state of the device at once and ends the server session. Until the server has ended
   * it, a marker keeps the device signed out and has the sign-out sent again: without a connection
   * (or after a 5xx or 429) when the server can answer, else at the next start or sign-in.
   * Navigating away is up to the caller.
   */
  logout: () => Promise<LogoutResult>;
  /** Drops everything private: the query cache, the registered stores, the other tabs' memory. */
  resetAccountState: () => Promise<void>;
  /**
   * After the account was deleted, forgets that this device kept its articles, unless the account
   * has signed in again since, in any tab, which restored it: all of it stays then. Drops its state
   * as `resetAccountState` does if the sign-in `signIn` lasts with the session cookie `cookie`
   * (`currentSignIn()` and `currentCookie()` when the deletion was asked for), or a 401 ended it,
   * which left the account's rows on the device; another account signed in since, or a sign-out
   * that removed the account already, is left as it is. Answers whether the account was dropped
   * here.
   */
  dropDeletedAccount: (accountId: string, signIn: number, cookie: number) => Promise<boolean>;
  /** Which sign-in lasts now. It changes with who is signed in, so work begun earlier can tell. */
  currentSignIn: () => number;
  /**
   * Which session cookie a request sent now goes out with, for `unauthorized`: there is a new one
   * at every sign-in and sign-out, in another tab and as the same account too.
   */
  currentCookie: () => number;
  /**
   * Ends the session after a 401 that did not come through `api`, such as the streamed export, if
   * the request went out with the session cookie that is still current (`currentCookie()` as it was
   * sent).
   */
  unauthorized: (sentWith: number) => void;
  /** Calls `listener` when someone signs in or out; returns the function that stops it. */
  subscribe: (listener: () => void) => () => void;
  dispose: () => void;
}

interface ResetMessage {
  type: 'reset';
  /** The account the sending tab dropped; absent when it knew none. */
  account?: unknown;
  /** The account whose rows the sending tab removes, from `at` on; absent when it keeps them. */
  removed?: unknown;
  at?: unknown;
}

function isResetMessage(data: unknown): data is ResetMessage {
  return typeof data === 'object' && data !== null && 'type' in data && data.type === 'reset';
}

interface SignedInMessage {
  type: 'signed-in';
  /** The account the sending tab signed in as. */
  me?: unknown;
}

function isSignedInMessage(data: unknown): data is SignedInMessage {
  return typeof data === 'object' && data !== null && 'type' in data && data.type === 'signed-in';
}

/** What the other tabs are told of a reset. */
function resetMessage(reason: ResetReason, accountId: string | undefined, at: number) {
  if (accountId === undefined) return { type: 'reset' };
  const removes = reason === 'logout' || reason === 'account_switch';
  return removes
    ? { type: 'reset', account: accountId, removed: accountId, at }
    : { type: 'reset', account: accountId };
}

/**
 * Who is signed in (spec 09 §1, §2). The account lives in the query cache under `meKey()`; this
 * keeps it and the rest of the private state consistent as sessions begin and end.
 */
export function createSession(options: SessionOptions): Session {
  const { queryClient, i18n } = options;
  // Counts the changes of who is signed in.
  let signIns = 0;
  // Counts the session cookies: one more at every change of who is signed in, and at every sign-in
  // of this tab or another, as the same account too. A request goes out with the cookie counted
  // then, and a 401 to it after another cookie came is about a session that has ended already.
  let cookies = 0;
  const api = createApiClient({
    fetch: options.fetch,
    session: () => cookies,
    onUnauthorized: unauthorizedIn,
  });
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
  // The account a switch shows once the previous one is removed, and whether it asks the server
  // instead, because of what came meanwhile (`switchAccount`).
  let arriving: { id: string; ask: boolean } | null = null;
  let finishing: Promise<void> | null = null;
  // Where the browser has no Web Locks, the work of this tab still takes turns.
  let ownTurn: Promise<unknown> = Promise.resolve();
  let logoutRetry: ReturnType<typeof setTimeout> | undefined;
  let logoutFailures = 0;
  let disposed = false;
  // How many times the account state was dropped, so work begun before that can tell.
  let resets = 0;
  // The session cookie the last 401 left: while it is still current, no tab has signed in since.
  let cookieAfter401: number | undefined;

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
   * first: until it is gone, nothing of that account can be stored or read. A reset meanwhile (a
   * sign-out, another account) drops the save, so it cannot bring back what the reset removed.
   */
  async function keepForOffline(me: Me) {
    const before = resets;
    await finishPendingPurges();
    if (resets === before) await saveMe(me.id, me);
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
        const removal = Promise.resolve().then(() => switchAccount(previousAccountId, me));
        switching = removal;
        void removal.finally(() => {
          if (switching === removal) switching = null;
        });
      }
    }
    const id = me?.id ?? null;
    const previous = signedInId;
    signedInId = id;
    if (previous !== undefined && previous !== id) {
      signIns += 1;
      cookies += 1;
      listeners.forEach((listener) => listener());
    }
  }

  const stopWatchingCache = queryClient.getQueryCache().subscribe((event) => {
    if (event.type === 'updated' && event.action.type === 'success') {
      if (event.query.queryHash === ME_HASH) meChanged(event.query.state.data as Me | null);
    }
  });

  if (channel !== null) {
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data;
      if (isSignedInMessage(message)) {
        // Every request of this tab goes out as that account from now on. A tab that shows another
        // one takes it as a `/me` answer for it would, the earlier account removed first; a tab that
        // shows nobody stays signed out, unless it is removing an earlier account to show another,
        // which asks who is signed in once that is done (`switchAccount`). A tab that shows the
        // same account goes on as it is: the same person is signed in, so its sign-in lasts and what
        // waits there still goes out, now with the new cookie; a 401 to a request sent before is no
        // news.
        cookies += 1;
        const shown = idInCache();
        if (typeof shown !== 'string') return;
        const signedIn = MeSchema.safeParse(message.me);
        if (!signedIn.success) {
          // A tab of another version of the app: this one asks who is signed in.
          void queryClient.refetchQueries({ queryKey: meKey(), exact: true });
        } else if (signedIn.data.id !== shown) {
          queryClient.setQueryData(meKey(), signedIn.data);
        }
        return;
      }
      if (!isResetMessage(message)) return;
      // A write of this tab must not bring back what the other tab removed.
      if (typeof message.removed === 'string' && typeof message.at === 'number') {
        void clearedElsewhere(message.removed, message.at);
      }
      // A tab that shows another account by now, signed in through the shared cookie, asks who is
      // signed in instead: the reset in the other tab (a sign-out, a 401) may or may not have ended
      // that session. Messages of different tabs come in no set order, so this one may come after
      // the news of that sign-in.
      const shown = idInCache();
      if (
        typeof message.account === 'string' &&
        typeof shown === 'string' &&
        shown !== message.account
      ) {
        void queryClient.refetchQueries({ queryKey: meKey(), exact: true });
        return;
      }
      // A tab about to show another account once the earlier one is removed asks too, when that is
      // done: the tab that signed in removes the earlier account as well.
      if (
        typeof message.account === 'string' &&
        arriving !== null &&
        arriving.id !== message.account
      ) {
        arriving.ask = true;
        return;
      }
      // A 401 there kept the account's rows on the device, so this tab still knows the account: a
      // sign-in of another one here removes them first. While this tab showed the account, the 401
      // ended its session as one of its own would, and a deletion answered here drops the rows.
      const after401 = typeof message.account === 'string' && typeof message.removed !== 'string';
      const known = knownAccountId;
      void reset('remote');
      if (after401) {
        knownAccountId = known;
        if (typeof shown === 'string') cookieAfter401 = cookies;
      }
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
    resets += 1;
    // Before the removal begins: the other tabs' writes from then on may land after it.
    const at = Date.now();
    queryClient.clear();
    queryClient.setQueryData(meKey(), null);
    if (reason === 'logout' || reason === 'remote') knownAccountId = undefined;
    const hooksDone = runResetHooks(reason);
    const removed = removeFromDevice(reason, accountId);
    if (reason !== 'remote') channel?.postMessage(resetMessage(reason, accountId, at));
    return Promise.all([hooksDone, removed]).then(() => undefined);
  }

  /**
   * Removes the previous account and then shows `me`, unless something decided otherwise meanwhile:
   * a sign-out or another reset leaves the tab signed out, and a sign-in in another tab, or a reset
   * there of another account than `me`, leaves it to the server to say who is signed in.
   */
  async function switchAccount(previousAccountId: string, me: Me): Promise<void> {
    const removed = reset('account_switch', previousAccountId);
    const before = { resets, cookies };
    const arrival = { id: me.id, ask: false };
    arriving = arrival;
    try {
      await removed;
    } finally {
      if (arriving === arrival) arriving = null;
    }
    if (resets !== before.resets) return;
    if (cookies === before.cookies && !arrival.ask) {
      queryClient.setQueryData(meKey(), me);
      return;
    }
    // Nobody is signed in while a sign-out is on its way to the server, whatever it still says.
    if (isLogoutPending()) return;
    await queryClient.fetchQuery({ ...meQuery, staleTime: 0 }).catch(() => undefined);
  }

  // The answer 401 of the `/me` probe itself arrives while nobody is known yet: nothing to drop.
  function handleUnauthorized() {
    if (!queryClient.getQueryData<Me | null>(meKey())) return;
    void reset('unauthorized');
    cookieAfter401 = cookies;
  }

  /** A 401 to a request sent with another session cookie than the current one is no news. */
  function unauthorizedIn(sentWith: unknown) {
    if (sentWith === cookies) handleUnauthorized();
  }

  async function endServerSession(): Promise<void> {
    try {
      await api.call(routes.authLogout);
    } catch (error) {
      // Already signed out is the state we are after.
      if (!isApiError(error) || error.status !== 401) throw error;
    }
  }

  /**
   * Runs `work` while no other tab of the browser runs work under the sign-in lock. The answer to a
   * sign-out clears the session cookie, so none may be on its way while a sign-in sets the next one.
   * Every browser the build targets has Web Locks in a secure context, which production always is;
   * without them, as in tests or over plain http, a tab only takes turns with itself.
   */
  async function exclusively<T>(work: () => Promise<T>): Promise<T> {
    if ('locks' in navigator) return navigator.locks.request(SIGN_IN_LOCK, () => work());
    const turn = ownTurn.then(work);
    ownTurn = turn.catch(() => undefined);
    return turn;
  }

  /** Ends the server session of a pending sign-out, unless another tab did while this one waited. */
  async function endPendingLogout(): Promise<void> {
    if (!isLogoutPending()) return;
    await endServerSession();
    clearTimeout(logoutRetry);
    logoutFailures = 0;
    clearLogoutPending();
  }

  /** Ends the server session of a pending sign-out; the tabs that see it take turns. */
  function finishPendingLogout(): Promise<void> {
    if (!isLogoutPending()) return Promise.resolve();
    finishing ??= exclusively(endPendingLogout).finally(() => {
      finishing = null;
    });
    return finishing;
  }

  /**
   * Sends a sign-out the server refused for now (network, 5xx, 429) again while the browser reports
   * a connection: a server that answers again sends no `online` event. The wait doubles up to five
   * minutes and is never shorter than the server's Retry-After (`retryLaterMs`, spec 09 §1).
   */
  function retryLogoutLater(error: unknown) {
    clearTimeout(logoutRetry);
    if (disposed || !isRetryable(error) || navigator.onLine === false) return;
    logoutFailures += 1;
    const asked = isApiError(error) ? error.retryAfterMs : null;
    logoutRetry = setTimeout(finishQuietly, retryLaterMs(logoutFailures, asked));
  }

  function finishQuietly() {
    finishPendingLogout().catch(retryLogoutLater);
  }

  window.addEventListener('online', finishQuietly);
  if (navigator.onLine !== false) finishQuietly();
  // What an earlier sign-out could not remove from the device goes now.
  void finishPendingPurges();

  async function restoreOffline(cause: unknown): Promise<Me | null> {
    const before = resets;
    const last = readLastAccount();
    const saved = last !== null && isOfflineEnabled(last.id) ? await readMe(last.id) : null;
    // A reset while the saved account was read (a sign-out in another tab) is not taken back.
    if (resets !== before) return queryClient.getQueryData<Me | null>(meKey()) ?? null;
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
    const { user } = await exclusively(async () => {
      try {
        await endPendingLogout();
      } catch (error) {
        // A sign-out the server refuses for another reason than the connection is given up: sent
        // after this sign-in, it would end the new session.
        if (isRetryable(error)) throw error;
        clearLogoutPending();
      }
      const answer = await api.call(routes.authVerify, { body: input });
      cookies += 1;
      // The session cookie of the browser is this account's now. The other tabs hear of the
      // sign-ins in the order they took the lock, so the last one they hear of holds the cookie.
      channel?.postMessage({ type: 'signed-in', me: answer.user });
      return answer;
    });
    const previousAccountId = knownAccountId;
    knownAccountId = user.id;
    if (previousAccountId !== undefined && previousAccountId !== user.id) {
      await switchAccount(previousAccountId, user);
    } else {
      queryClient.setQueryData(meKey(), user);
    }
    return user;
  }

  async function dropDeletedAccount(
    accountId: string,
    signIn: number,
    cookie: number,
  ): Promise<boolean> {
    const lasts = signIns === signIn && cookies === cookie;
    // A 401 since is the deletion too, which ended every session of the account: the tab is signed
    // out, and what the 401 kept of the account goes now. Not once any tab has signed in since that
    // 401: the account itself, signed in again, is restored.
    const endedBy401 = signIns === signIn + 1 && idInCache() === null && cookies === cookieAfter401;
    // Signed in again since, in this tab or another, the account is restored: all of it stays.
    if (knownAccountId === accountId && !lasts && !endedBy401) return false;
    // Unlike a sign-out, a deletion also forgets that this device kept the account's articles.
    writeOfflineEnabled(accountId, false);
    if (knownAccountId !== accountId) return false;
    await reset('logout', accountId);
    return true;
  }

  async function logout(): Promise<LogoutResult> {
    // The device is signed out before the server answers, which may take long or never come if the
    // page closes first; the marker then ends the server session at the next start (spec 09 §1).
    markLogoutPending();
    const cleared = reset('logout', knownAccountId);
    const ended = finishPendingLogout().then(
      () => 'signed_out' as const,
      (error: unknown) => {
        retryLogoutLater(error);
        return isRetryable(error) ? ('pending' as const) : ('refused' as const);
      },
    );
    await cleared;
    return { server: await ended };
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
    dropDeletedAccount,
    currentSignIn: () => signIns,
    currentCookie: () => cookies,
    unauthorized: unauthorizedIn,
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
