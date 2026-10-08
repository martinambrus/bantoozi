import { useTranslation } from 'react-i18next';

import { EmptyState } from '../../components/states/empty-state.js';
import { QueryState } from '../../components/states/query-state.js';
import { AddFeedForm } from './add-feed-form.js';
import { FolderList } from './folder-list.js';
import { OpmlSection } from './opml-section.js';
import { useSubscriptions } from './subscriptions.js';

function Feeds() {
  const { t } = useTranslation('feeds');
  const subscriptions = useSubscriptions();
  return (
    <QueryState
      query={subscriptions}
      isEmpty={(list) => list.length === 0}
      empty={<EmptyState title={t('empty.title')} body={t('empty.body')} />}
    >
      {(list) => <FolderList subscriptions={list} />}
    </QueryState>
  );
}

export function FeedsPage() {
  const { t } = useTranslation('feeds');
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-6">
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      <AddFeedForm />
      <Feeds />
      <OpmlSection />
    </div>
  );
}
