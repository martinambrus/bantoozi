import type { CardDto } from '@bantoozi/shared';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../api/errors.js';
import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Badge } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { errorMessage } from '../../components/error-message.js';
import { EmptyState } from '../../components/states/empty-state.js';
import { LoadingState } from '../../components/states/loading-state.js';
import { QueryState } from '../../components/states/query-state.js';
import { FormAlert } from '../auth/form-alert.js';
import { conflictReason } from './card-errors.js';
import { CardEditor } from './card-editor.js';
import { useKeptOffers } from './kept-updates.js';
import { useCardCache, useCards, useUpdates, type UpdateOffer } from './queries.js';
import { UpdateDiff } from './update-diff.js';

function OfferItem({ offer, card }: { offer: UpdateOffer; card: CardDto | undefined }) {
  const { t } = useTranslation('interests');
  const cache = useCardCache();
  const apply = useApiMutation(routes.libraryUpdateApply);
  const kept = useKeptOffers();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const titleId = useId();
  const noteId = useId();

  function refreshAndExplain(error: unknown): string {
    const reason = conflictReason(error);
    if (reason === 'private_holding') {
      cache.refreshUpdates();
      return t('updates.errors.privateHolding');
    }
    if (reason === 'holding_mismatch') {
      cache.refreshUpdates();
      cache.refreshCards();
      return t('updates.errors.holdingMismatch');
    }
    if (reason === 'target_held') {
      cache.refreshCards();
      return t('updates.errors.targetHeld');
    }
    if (isApiError(error) && error.status === 404) {
      cache.refreshUpdates();
      return t('updates.errors.gone');
    }
    return errorMessage(t, error);
  }

  async function applyUpdate() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      cache.apply(
        await apply.mutateAsync({
          params: { id: offer.baseCardId, newId: offer.newCardId },
          body: { expectedCurrentCardId: offer.currentCardId },
        }),
      );
      cache.dropOffer(offer.currentCardId);
    } catch (error) {
      setMessage(refreshAndExplain(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded-xl border border-slate-300 p-4 dark:border-slate-600"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 id={titleId} className="min-w-0 break-words text-base font-semibold">
          {card?.title ?? offer.librarySlug}
        </h3>
        <Badge tone="info">{t('updates.available', { version: offer.toVersion })}</Badge>
      </div>
      <UpdateDiff offer={offer} />
      <p id={noteId} className="text-sm text-slate-600 dark:text-slate-300">
        {offer.hasPrivateCustomization ? t('updates.privateNote') : t('updates.applyNote')}
      </p>
      {message === null ? null : <FormAlert>{message}</FormAlert>}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={offer.hasPrivateCustomization}
          loading={busy}
          aria-describedby={noteId}
          onClick={() => void applyUpdate()}
        >
          {t('updates.apply')}
        </Button>
        <Button variant="secondary" onClick={() => kept.keep(offer)}>
          {t('updates.keep')}
        </Button>
        <Button
          variant="secondary"
          disabled={card === undefined}
          onClick={() => setCustomizing(true)}
        >
          {t('updates.customize')}
        </Button>
      </div>
      {customizing && card !== undefined ? (
        <CardEditor card={card} review={offer} onClose={() => setCustomizing(false)} />
      ) : null}
    </li>
  );
}

/** New versions of the library cards the person holds. Nothing here changes by itself. */
export function LibraryUpdates() {
  const { t } = useTranslation('interests');
  const updates = useUpdates();
  const cards = useCards();
  const kept = useKeptOffers();
  const headingId = useId();
  const keptCount = updates.data?.filter((offer) => kept.isKept(offer)).length ?? 0;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-xl font-semibold">
          {t('updates.heading')}
        </h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">{t('updates.lead')}</p>
      </div>
      {keptCount === 0 ? null : (
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {t('updates.kept', { count: keptCount })}
        </p>
      )}
      <QueryState
        query={updates}
        isEmpty={(list) => list.every((offer) => kept.isKept(offer))}
        empty={<EmptyState title={t('updates.emptyTitle')} body={t('updates.emptyBody')} />}
      >
        {(list) =>
          // The titles come from the cards, so an offer is never first shown under its library name.
          cards.isLoading ? (
            <LoadingState />
          ) : (
            <ul aria-labelledby={headingId} className="flex flex-col gap-3">
              {list
                .filter((offer) => !kept.isKept(offer))
                .map((offer) => (
                  <OfferItem
                    key={`${offer.currentCardId}:${offer.toVersion}`}
                    offer={offer}
                    card={cards.data?.find((card) => card.id === offer.currentCardId)}
                  />
                ))}
            </ul>
          )
        }
      </QueryState>
    </section>
  );
}
