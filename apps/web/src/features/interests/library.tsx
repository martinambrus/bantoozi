import type { LibraryCardDto } from '@bantoozi/shared';
import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/button.js';
import { errorMessage } from '../../components/error-message.js';
import { SearchIcon } from '../../components/icons.js';
import { Select } from '../../components/select.js';
import { EmptyState } from '../../components/states/empty-state.js';
import { LoadingState } from '../../components/states/loading-state.js';
import { QueryState } from '../../components/states/query-state.js';
import { TextField } from '../../components/text-field.js';
import { FormAlert } from '../auth/form-alert.js';
import { AdoptControl } from './adopt-control.js';
import { LibraryCardItem } from './library-card-item.js';
import { useLibrary } from './queries.js';
import { useTopicIndex, type TopicIndex } from './topics.js';

const SEARCH_MAX = 200;

function LibraryRow({ card, topics }: { card: LibraryCardDto; topics: readonly string[] }) {
  const [message, setMessage] = useState<string | null>(null);
  return (
    <LibraryCardItem card={card} topics={topics} heading="h4">
      <AdoptControl card={card} onMessage={setMessage} />
      {message === null ? null : <FormAlert>{message}</FormAlert>}
    </LibraryCardItem>
  );
}

function CardGroup({ name, children }: { name: string | null; children: ReactNode }) {
  const { t } = useTranslation('interests');
  const headingId = useId();
  return (
    <div className="flex flex-col gap-3">
      {name === null ? null : (
        <h3 id={headingId} className="text-lg font-semibold">
          {name}
        </h3>
      )}
      <ul
        aria-labelledby={name === null ? undefined : headingId}
        aria-label={name === null ? t('library.heading') : undefined}
        className="flex flex-col gap-3"
      >
        {children}
      </ul>
    </div>
  );
}

interface Group {
  /** The level-1 topic; empty for cards without one. */
  key: string;
  name: string | null;
  items: LibraryCardDto[];
}

/** The cards in the order they came, a heading for each run of one level-1 topic. */
function groupByTopic(
  items: readonly LibraryCardDto[],
  index: TopicIndex | null,
  other: string,
): Group[] {
  if (index === null) return [{ key: '', name: null, items: [...items] }];
  const groups: Group[] = [];
  for (const item of items) {
    const key = item.l1TopicId ?? '';
    const last = groups.at(-1);
    if (last?.key === key) {
      last.items.push(item);
    } else {
      groups.push({ key, name: index.name(key) ?? other, items: [item] });
    }
  }
  return groups;
}

/** Ready-made cards to browse by topic or search for, and add. */
export function Library() {
  const { t } = useTranslation('interests');
  const { topics, index } = useTopicIndex();
  const [topic, setTopic] = useState('');
  const [draft, setDraft] = useState('');
  const [words, setWords] = useState('');
  const library = useLibrary({
    topic: topic === '' ? undefined : topic,
    q: words === '' ? undefined : words,
  });
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-xl font-semibold">
          {t('library.heading')}
        </h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">{t('library.lead')}</p>
      </div>
      <form
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          setWords(draft.trim());
        }}
      >
        {index === null ? null : (
          <Select
            label={t('library.topic')}
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            className="sm:w-64"
          >
            <option value="">{t('library.allTopics')}</option>
            {index.groups.map((group) => (
              <optgroup key={group.parent.id} label={group.name}>
                <option value={group.parent.id}>{t('library.allOf', { topic: group.name })}</option>
                {group.children.map((child) => (
                  <option key={child.topic.id} value={child.topic.id}>
                    {child.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        )}
        <TextField
          type="search"
          label={t('library.search')}
          value={draft}
          maxLength={SEARCH_MAX}
          onChange={(event) => setDraft(event.target.value)}
          className="sm:flex-1"
        />
        <Button type="submit" variant="secondary">
          <SearchIcon className="size-4" />
          {t('library.searchButton')}
        </Button>
      </form>
      <QueryState
        query={library}
        isEmpty={(data) => data.pages.every((page) => page.items.length === 0)}
        empty={<EmptyState title={t('library.emptyTitle')} body={t('library.emptyBody')} />}
      >
        {(data) =>
          // The topic names come first, so the headings never appear one at a time.
          topics.isLoading ? (
            <LoadingState />
          ) : (
            <div className="flex flex-col gap-6">
              {groupByTopic(
                data.pages.flatMap((page) => page.items),
                index,
                t('library.other'),
              ).map((group, position) => (
                <CardGroup key={`${position}:${group.key}`} name={group.name}>
                  {group.items.map((card) => (
                    <LibraryRow
                      key={card.id}
                      card={card}
                      topics={card.topicIds.flatMap((id) => index?.name(id) ?? [])}
                    />
                  ))}
                </CardGroup>
              ))}
              {library.isFetchNextPageError ? (
                <FormAlert>{errorMessage(t, library.error)}</FormAlert>
              ) : null}
              {library.hasNextPage ? (
                <div className="flex justify-center">
                  <Button
                    variant="secondary"
                    loading={library.isFetchingNextPage}
                    onClick={() => void library.fetchNextPage()}
                  >
                    {t('library.loadMore')}
                  </Button>
                </div>
              ) : null}
            </div>
          )
        }
      </QueryState>
    </section>
  );
}
