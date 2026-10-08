import type { AdminLibraryCard } from '@bantoozi/shared';
import { getRouteApi } from '@tanstack/react-router';
import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../api/context.js';
import { routes } from '../../api/routes.js';
import { Badge } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { EmptyState } from '../../components/states/empty-state.js';
import { QueryState } from '../../components/states/query-state.js';
import { Fact, Facts, LoadMore, SearchForm, SectionTitle } from './admin-ui.js';
import { Time } from './format.js';
import { LibraryCardDialog } from './library-card-dialog.js';
import { TopicList } from './library-topics.js';
import { useAdminPages, useRefresh } from './use-admin.js';

const route = getRouteApi('/_authed/_app/admin/library');

/** The highest version of each slug among the cards loaded so far. */
function newestVersions(cards: readonly AdminLibraryCard[]): Map<string, number> {
  const newest = new Map<string, number>();
  for (const card of cards) {
    if (card.slug === null || card.version === null) continue;
    newest.set(card.slug, Math.max(newest.get(card.slug) ?? 0, card.version));
  }
  return newest;
}

function PublicationRecord({ card }: { card: AdminLibraryCard }) {
  const { t } = useTranslation('admin');
  const { publication } = card;
  if (publication === null) {
    return (
      <Fact label={t('library.publication.label')}>
        <Badge>{t('library.publication.original')}</Badge>
      </Fact>
    );
  }
  return (
    <Fact label={t('library.publication.label')}>
      <Badge tone={publication.authorizationKind === 'creator_approval' ? 'success' : 'info'}>
        {t(`library.basis.${publication.authorizationKind}`)}
      </Badge>
      <p className="mt-1">
        {t('library.publication.on')} <Time value={publication.promotedAt} />
      </p>
    </Fact>
  );
}

function ExampleList({ label, items }: { label: string; items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <Fact label={label}>
      <ul className="list-disc ps-5">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </Fact>
  );
}

function CardEntry({
  card,
  supersededBy,
  onEdit,
}: {
  card: AdminLibraryCard;
  supersededBy: number | null;
  onEdit: () => void;
}) {
  const { t } = useTranslation('admin');
  const headingId = useId();
  const { sk } = card.i18n;
  return (
    <article
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border border-slate-300 p-4 dark:border-slate-600"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h4 id={headingId} className="text-base font-semibold">
            {card.title}
          </h4>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {card.slug === null ? null : <code>{card.slug}</code>}
            {card.version === null ? null : (
              <Badge>{t('library.version', { version: card.version })}</Badge>
            )}
            <span>{t('library.holders', { count: card.holders })}</span>
            {card.retiredAt === null ? null : <Badge tone="warning">{t('library.retired')}</Badge>}
            {supersededBy === null ? null : (
              <Badge tone="warning">{t('library.superseded', { version: supersededBy })}</Badge>
            )}
          </div>
        </div>
        <Button
          size="sm"
          variant="secondary"
          aria-label={t('library.editLabel', { title: card.title })}
          disabled={supersededBy !== null}
          onClick={onEdit}
        >
          {t('common:actions.edit')}
        </Button>
      </div>
      <Facts>
        <Fact label={t('library.fields.interest')}>{card.interest}</Fact>
        {card.notFor === null ? null : (
          <Fact label={t('library.fields.notFor')}>{card.notFor}</Fact>
        )}
        <ExampleList label={t('library.fields.examplesYes')} items={card.examplesYes} />
        <ExampleList label={t('library.fields.examplesNo')} items={card.examplesNo} />
        {card.topicIds.length === 0 ? null : (
          <Fact label={t('library.fields.topics')}>
            <TopicList topics={card.topicIds} />
          </Fact>
        )}
        {sk?.title === undefined ? null : (
          <Fact label={t('library.fields.skTitle')}>{sk.title}</Fact>
        )}
        {sk?.interest === undefined ? null : (
          <Fact label={t('library.fields.skInterest')}>{sk.interest}</Fact>
        )}
        <PublicationRecord card={card} />
      </Facts>
    </article>
  );
}

export function LibraryCards() {
  const { t } = useTranslation('admin');
  const api = useApi();
  const refresh = useRefresh();
  const headingId = useId();
  const { q } = route.useSearch();
  const navigate = route.useNavigate();
  const [editing, setEditing] = useState<AdminLibraryCard | 'new' | null>(null);

  const cards = useAdminPages<AdminLibraryCard>(['library', 'cards', { q }], (cursor, signal) =>
    api.call(routes.adminLibraryList, { query: { cursor, q } }, { signal }),
  );
  const newest = useMemo(() => newestVersions(cards.rows ?? []), [cards.rows]);

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <SectionTitle id={headingId}>{t('library.cards.title')}</SectionTitle>
        <Button onClick={() => setEditing('new')}>{t('library.create')}</Button>
      </div>
      <SearchForm
        label={t('library.search')}
        value={q ?? ''}
        onSearch={(text) =>
          void navigate({
            search: (previous) => ({ ...previous, q: text === '' ? undefined : text }),
          })
        }
      />
      <QueryState
        query={cards.source}
        isEmpty={(rows) => rows.length === 0}
        empty={<EmptyState title={t('library.cards.empty')} />}
      >
        {(rows) => (
          <>
            <ul className="flex flex-col gap-3">
              {rows.map((card) => {
                const latest = card.slug === null ? undefined : newest.get(card.slug);
                const supersededBy =
                  latest !== undefined && card.version !== null && latest > card.version
                    ? latest
                    : null;
                return (
                  <li key={card.cardId}>
                    <CardEntry
                      card={card}
                      supersededBy={supersededBy}
                      onEdit={() => setEditing(card)}
                    />
                  </li>
                );
              })}
            </ul>
            <LoadMore
              hasMore={cards.hasMore}
              loading={cards.loadingMore}
              onLoadMore={cards.loadMore}
            />
          </>
        )}
      </QueryState>
      {editing === null ? null : (
        <LibraryCardDialog
          card={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onChanged={() => void refresh('library', 'cards')}
        />
      )}
    </section>
  );
}
