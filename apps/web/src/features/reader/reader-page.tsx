import { useTranslation } from 'react-i18next';

import type { ReaderView } from './view.js';

export function ReaderPage({ view }: { view: ReaderView }) {
  const { t } = useTranslation('reader');
  return (
    <main data-view={view.kind}>
      <h1>{t('title')}</h1>
    </main>
  );
}
