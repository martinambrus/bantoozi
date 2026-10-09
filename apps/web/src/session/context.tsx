import type { Me } from '@bantoozi/shared';
import { useQuery } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

import { useApi } from '../api/context.js';
import { meQueryOptions } from './me.js';
import type { Session } from './session.js';

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ session, children }: { session: Session; children: ReactNode }) {
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

/** The session, or null where a screen is rendered without a `<SessionProvider>`. */
export function useOptionalSession(): Session | null {
  return useContext(SessionContext);
}

/**
 * Whether the sign-in this component was mounted in still lasts. Everything under `_authed` unmounts
 * when it ends, but an answer can come later, and the same account, signed in again, loads its cache
 * under the same keys: what such an answer would write there belongs to a sign-in that has ended.
 * Without a `<SessionProvider>`, it always lasts.
 */
export function useSignInLasts(): () => boolean {
  const session = useOptionalSession();
  const [signIn] = useState(() => session?.currentSignIn());
  return useCallback(
    () => session === null || session.currentSignIn() === signIn,
    [session, signIn],
  );
}

/** The session for the screens that sign in and out. */
export function useSession(): Session {
  const session = useContext(SessionContext);
  if (session === null) throw new Error('useSession() needs a <SessionProvider> above it');
  return session;
}

/**
 * The signed-in account, kept current by the `/me` query. Only for components under the `_authed`
 * layout, which renders nothing once the account is gone.
 */
export function useMe(): Me {
  const api = useApi();
  const { data } = useQuery(meQueryOptions(api));
  if (!data) throw new Error('useMe() was called without a signed-in account');
  return data;
}

/** The key prefix of everything cached for the signed-in account (`accountKey`). */
export function useAccountId(): string {
  return useMe().id;
}
