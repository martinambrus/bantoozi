import type { Me } from '@bantoozi/shared';
import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, type ReactNode } from 'react';

import { useApi } from '../api/context.js';
import { meQueryOptions } from './me.js';
import type { Session } from './session.js';

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ session, children }: { session: Session; children: ReactNode }) {
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
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
