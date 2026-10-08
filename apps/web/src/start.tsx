import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App, createAppServices } from './app.js';
import { createI18n, detectLanguage } from './i18n/index.js';
import './styles.css';

const i18n = createI18n(detectLanguage(navigator.languages));
document.documentElement.lang = i18n.language;
const services = createAppServices({ i18n });

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root element');
createRoot(root).render(
  <StrictMode>
    <App services={services} />
  </StrictMode>,
);
