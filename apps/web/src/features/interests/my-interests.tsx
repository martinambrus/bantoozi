import type { CardDto, Subscription } from '@bantoozi/shared';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Badge } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { PlusIcon, TrashIcon } from '../../components/icons.js';
import { EmptyState } from '../../components/states/empty-state.js';
import { LoadingState } from '../../components/states/loading-state.js';
import { QueryState } from '../../components/states/query-state.js';
import { useToast } from '../../components/toast/toast-provider.js';
import { saveMessage } from './card-errors.js';
import { CardEditor } from './card-editor.js';
import { BrowseLibraryLink, ScopeSelect, StrengthControl } from './controls.js';
import { ExampleLists, exampleKey, type ExampleSide } from './examples.js';
import { useCardCache, useCards, useSubscriptions } from './queries.js';
import type { Strength } from './strengths.js';

type Change = { strength: Strength } | { scopeFeedId: string | null };

interface CardRowProps {
  card: CardDto;
  subscriptions: readonly Subscription[];
  onEdit: (card: CardDto) => void;
  onDelete: (card: CardDto) => void;
}

function CardRow({ card, subscriptions, onEdit, onDelete }: CardRowProps) {
  const { t } = useTranslation('interests');
  const toast = useToast();
  const cache = useCardCache();
  const update = useApiMutation(routes.cardUpdate);
  const removeExample = useApiMutation(routes.cardExampleRemove);
  const [removing, setRemoving] = useState<string | null>(null);
  const titleId = useId();

  // The change shows at once; a failure takes back only that change, and says why.
  async function change(changes: Change) {
    const before = cache.patch(card.id, changes);
    try {
      cache.apply(await update.mutateAsync({ params: { id: card.id }, body: changes }));
    } catch (error) {
      if (before !== undefined) cache.undo(card.id, before, changes);
      toast.show({ message: saveMessage(t, error), tone: 'error' });
    }
  }

  async function remove(side: ExampleSide, text: string) {
    setRemoving(exampleKey(side, text));
    try {
      cache.apply(
        await removeExample.mutateAsync({ params: { id: card.id }, body: { side, text } }),
      );
    } catch (error) {
      toast.show({ message: saveMessage(t, error), tone: 'error' });
    } finally {
      setRemoving(null);
    }
  }

  return (
    <li
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded-xl border border-slate-300 p-4 dark:border-slate-600"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 id={titleId} className="min-w-0 break-words text-base font-semibold">
          {card.title}
        </h3>
        {card.origin === 'user' ? null : (
          <Badge tone="info">
            {card.origin === 'library' ? t('card.origin.library') : t('card.origin.fork')}
          </Badge>
        )}
      </div>
      <p className="break-words text-sm">{card.interest}</p>
      {card.notFor === null ? null : (
        <p className="break-words text-sm text-slate-600 dark:text-slate-300">
          {t('card.notFor', { text: card.notFor })}
        </p>
      )}
      <ExampleLists
        yes={card.examplesYes}
        no={card.examplesNo}
        moreLabel={t('card.examplesMore')}
        lessLabel={t('card.examplesLess')}
        removal={{
          label: (text) => t('card.removeExample', { text }),
          onRemove: (side, text) => void remove(side, text),
          removing,
        }}
      />
      <div className="flex flex-wrap items-end gap-4">
        <StrengthControl
          value={card.strength}
          onChange={(strength) => {
            if (strength !== card.strength) void change({ strength });
          }}
        />
        <ScopeSelect
          value={card.scopeFeedId}
          subscriptions={subscriptions}
          onChange={(scopeFeedId) => void change({ scopeFeedId })}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" aria-describedby={titleId} onClick={() => onEdit(card)}>
          {t('common:actions.edit')}
        </Button>
        <Button variant="ghost" aria-describedby={titleId} onClick={() => onDelete(card)}>
          <TrashIcon className="size-4" />
          {t('common:actions.delete')}
        </Button>
      </div>
    </li>
  );
}

/** The person's own interest cards. */
export function MyInterests() {
  const { t } = useTranslation('interests');
  const cache = useCardCache();
  const cards = useCards();
  const subscriptions = useSubscriptions();
  const deleteCard = useApiMutation(routes.cardDelete);
  const [editing, setEditing] = useState<CardDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<CardDto | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const headingId = useId();

  async function remove(card: CardDto) {
    await deleteCard.mutateAsync({ params: { id: card.id } });
    cache.remove(card.id);
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={headingId} className="text-xl font-semibold">
          {t('mine.heading')}
        </h2>
        <Button onClick={() => setEditing('new')}>
          <PlusIcon className="size-4" />
          {t('mine.new')}
        </Button>
      </div>
      <QueryState
        query={cards}
        isEmpty={(list) => list.length === 0}
        empty={
          <EmptyState
            title={t('mine.emptyTitle')}
            body={t('mine.emptyBody')}
            action={<BrowseLibraryLink />}
          />
        }
      >
        {(list) =>
          // The feed names come with the cards, so a card is never first shown with "Another feed".
          subscriptions.isLoading ? (
            <LoadingState />
          ) : (
            <ul
              ref={listRef}
              tabIndex={-1}
              aria-label={t('mine.listLabel')}
              className="flex flex-col gap-3 outline-none"
            >
              {list.map((card) => (
                <CardRow
                  key={card.id}
                  card={card}
                  subscriptions={subscriptions.data ?? []}
                  onEdit={setEditing}
                  onDelete={setDeleting}
                />
              ))}
            </ul>
          )
        }
      </QueryState>
      {editing === null ? null : (
        <CardEditor
          card={editing === 'new' ? undefined : editing}
          returnFocus={() => listRef.current}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting === null ? null : (
        <ConfirmDialog
          open
          danger
          title={t('card.deleteTitle')}
          body={t('card.deleteBody', { title: deleting.title })}
          confirmLabel={t('common:actions.delete')}
          returnFocus={() => listRef.current}
          onClose={() => setDeleting(null)}
          onConfirm={() => remove(deleting)}
        />
      )}
    </section>
  );
}
