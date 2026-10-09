import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { RouterProvider, type RouterHistory } from '@tanstack/react-router';
import type { i18n as I18n } from 'i18next';
import { I18nextProvider } from 'react-i18next';

import { ApiProvider } from './api/context.js';
import { createQueryClient } from './api/query-client.js';
import { createAppRouter } from './router.js';
import { SessionProvider } from './session/context.js';
import { createSession, type Session } from './session/session.js';

export interface AppServices {
  i18n: I18n;
  queryClient: QueryClient;
  session: Session;
  router: ReturnType<typeof createAppRouter>;
}

/** The app's long-lived objects; tests pass a fake `fetch` and a memory history. */
export function createAppServices(options: {
  i18n: I18n;
  fetch?: typeof fetch | undefined;
  history?: RouterHistory | undefined;
  queryClient?: QueryClient | undefined;
}): AppServices {
  const { i18n } = options;
  const queryClient = options.queryClient ?? createQueryClient();
  const session = createSession({ queryClient, i18n, fetch: options.fetch });
  const router = createAppRouter({ queryClient, loadMe: session.loadMe }, options.history);
  // Signing in or out changes what the route guards answer.
  session.subscribe(() => void router.invalidate());
  return { i18n, queryClient, session, router };
}

export function App({ services }: { services: AppServices }) {
  const { i18n, queryClient, session, router } = services;
  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <ApiProvider client={session.api}>
          <SessionProvider session={session}>
            <RouterProvider router={router} />
          </SessionProvider>
        </ApiProvider>
      </QueryClientProvider>
    </I18nextProvider>
  );
}
