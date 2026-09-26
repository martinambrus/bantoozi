import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';

import { createI18n, detectLanguage } from './i18n/index.js';
import { createAppRouter } from './router.js';
import './styles.css';

const i18n = createI18n(detectLanguage(navigator.languages));
document.documentElement.lang = i18n.language;
const router = createAppRouter();
const queryClient = new QueryClient();

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root element');
createRoot(root).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nextProvider>
  </StrictMode>,
);
