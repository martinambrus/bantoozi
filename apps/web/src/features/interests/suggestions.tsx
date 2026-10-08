import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Button } from '../../components/button.js';
import { errorMessage } from '../../components/error-message.js';
import { EmptyState } from '../../components/states/empty-state.js';
import { QueryState } from '../../components/states/query-state.js';
import { FormAlert } from '../auth/form-alert.js';
import { AdoptControl } from './adopt-control.js';
import { BrowseLibraryLink } from './controls.js';
import { LibraryCardItem } from './library-card-item.js';
import { useCardCache, useSuggestions, type Suggestion } from './queries.js';

function SuggestionRow({ suggestion }: { suggestion: Suggestion }) {
  const { t } = useTranslation('interests');
  const cache = useCardCache();
  const dismiss = useApiMutation(routes.cardSuggestionDismiss);
  const [message, setMessage] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const { card } = suggestion;

  async function dismissCard() {
    if (dismissing) return;
    setDismissing(true);
    setMessage(null);
    try {
      await dismiss.mutateAsync({ params: { cardId: card.id } });
      cache.dropSuggestion(card.id);
    } catch (error) {
      setMessage(errorMessage(t, error));
    } finally {
      setDismissing(false);
    }
  }

  return (
    <LibraryCardItem card={card} heading="h3">
      <div className="flex flex-wrap items-end gap-2">
        <AdoptControl card={card} onMessage={setMessage} />
        <Button variant="ghost" loading={dismissing} onClick={() => void dismissCard()}>
          {t('common:actions.dismiss')}
        </Button>
      </div>
      {message === null ? null : <FormAlert>{message}</FormAlert>}
    </LibraryCardItem>
  );
}

/** Library cards Bantoozi thinks the person might like. */
export function Suggestions() {
  const { t } = useTranslation('interests');
  const suggestions = useSuggestions();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-xl font-semibold">
          {t('suggestions.heading')}
        </h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">{t('suggestions.lead')}</p>
      </div>
      <QueryState
        query={suggestions}
        isEmpty={(list) => list.length === 0}
        empty={
          <EmptyState
            title={t('suggestions.emptyTitle')}
            body={t('suggestions.emptyBody')}
            action={<BrowseLibraryLink />}
          />
        }
      >
        {(list) => (
          <ul aria-labelledby={headingId} className="flex flex-col gap-3">
            {list.map((suggestion) => (
              <SuggestionRow key={suggestion.card.id} suggestion={suggestion} />
            ))}
          </ul>
        )}
      </QueryState>
    </section>
  );
}
