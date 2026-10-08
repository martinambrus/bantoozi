import { createContext, useContext, type ReactNode } from 'react';

import type { ApiClient } from './client.js';

const ApiContext = createContext<ApiClient | null>(null);

export function ApiProvider({ client, children }: { client: ApiClient; children: ReactNode }) {
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}

/** The client of the nearest `ApiProvider`; tests give it one with a fake `fetch`. */
export function useApi(): ApiClient {
  const client = useContext(ApiContext);
  if (client === null) throw new Error('useApi() needs an <ApiProvider> above it');
  return client;
}
