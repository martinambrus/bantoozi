import { useTranslation } from 'react-i18next';

import { PageTitle } from './admin-ui.js';
import { LibraryCandidates } from './library-candidates.js';
import { LibraryCards } from './library-cards.js';

export function AdminLibraryPage() {
  const { t } = useTranslation('admin');
  return (
    <div className="flex flex-col gap-8">
      <PageTitle>{t('nav.library')}</PageTitle>
      <LibraryCards />
      <LibraryCandidates />
    </div>
  );
}
