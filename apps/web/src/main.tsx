import './zod-jitless.js';

import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';

import { ApiProvider } from './api/context.js';
import { createQueryClient } from './api/query-client.js';
import { createI18n, detectLanguage } from './i18n/index.js';
import { createAppRouter } from './router.js';
import { SessionProvider } from './session/context.js';
import { createSession } from './session/session.js';
import './styles.css';

const i18n = createI18n(detectLanguage(navigator.languages));
document.documentElement.lang = i18n.language;
const queryClient = createQueryClient();
const session = createSession({ queryClient, i18n });
const router = createAppRouter({ queryClient, loadMe: session.loadMe });
// Signing in or out changes what the route guards answer.
session.subscribe(() => void router.invalidate());

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root element');
createRoot(root).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <ApiProvider client={session.api}>
          <SessionProvider session={session}>
            <RouterProvider router={router} />
          </SessionProvider>
        </ApiProvider>
      </QueryClientProvider>
    </I18nextProvider>
  </StrictMode>,
);
