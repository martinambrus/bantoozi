import { useTranslation } from 'react-i18next';

import { TextField } from '../../components/text-field.js';
import { useFeedFilter, useReaderTargets } from './reader-state.js';

export interface FeedFilterProps {
  /** No feed has a title that matches what was typed. */
  noMatch: boolean;
}

/**
 * The field above the feeds of the sidebar (spec 09 §3.4): it narrows them by title as it is
 * typed, Escape empties it, and the `/` key brings the focus to it.
 */
export function FeedFilter({ noMatch }: FeedFilterProps) {
  const { t } = useTranslation('reader');
  const [filter, setFilter] = useFeedFilter();
  const { feedFilter } = useReaderTargets();

  return (
    <div>
      <TextField
        ref={feedFilter}
        label={t('sidebar.filter')}
        value={filter}
        autoComplete="off"
        aria-keyshortcuts="/"
        onChange={(event) => setFilter(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || filter === '') return;
          event.preventDefault();
          setFilter('');
        }}
      />
      <p
        role="status"
        className={noMatch ? 'px-3 pt-2 text-sm text-slate-600 dark:text-slate-300' : undefined}
      >
        {noMatch ? t('sidebar.noMatch') : null}
      </p>
    </div>
  );
}
