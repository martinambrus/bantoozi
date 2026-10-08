import type { CardDto, Me } from '@bantoozi/shared';
import type { QueryClient } from '@tanstack/react-query';
import type { i18n as I18n } from 'i18next';

import type { ApiClient } from '../../api/client.js';
import { meKey } from '../../api/query-keys.js';
import type { RouteOutput } from '../../api/route.js';
import { routes } from '../../api/routes.js';
import { errorMessage } from '../../components/error-message.js';
import type { ToastApi } from '../../components/toast/toast-provider.js';
import type { ToastAction } from '../../components/toast/toast-store.js';
import { currentCardId } from '../interests/card-moves.js';
import { cardCache, ensureCards } from '../interests/queries.js';
import type { ExampleSuggestion } from '../reader/actions/types.js';
import { announceTaught, announceTeachFailure } from '../why/use-card-teacher.js';

export interface ExampleOffersEnvironment {
  api: ApiClient;
  queryClient: QueryClient;
  /** Where the confirmations and errors go. */
  toast: Pick<ToastApi, 'show'>;
  i18n: I18n;
  accountId: string;
}

export interface ExampleOffers {
  /**
   * The actions that offer to teach the card of `suggestion` (spec 09 §3.3) and to stop such
   * offers, or null when the card is not among the ones the person holds or the cards cannot be read.
   */
  actionsFor(
    suggestion: ExampleSuggestion,
    articleId: string,
  ): Promise<readonly ToastAction[] | null>;
  /** Aborts the requests of the offers taken up and forgets them: nothing more is shown for them. */
  release(): void;
}

/** What a rating's example suggestion adds to its undo toast, and what pressing it does. */
export function createExampleOffers({
  api,
  queryClient,
  toast,
  i18n,
  accountId,
}: ExampleOffersEnvironment): ExampleOffers {
  const why = i18n.getFixedT(null, 'why');
  const cache = cardCache(queryClient, accountId);
  let controller = new AbortController();

  async function teach({ cardId, side }: ExampleSuggestion, articleId: string): Promise<void> {
    const { signal } = controller;
    let answer: RouteOutput<typeof routes.cardExampleAdd>;
    try {
      answer = await api.call(
        routes.cardExampleAdd,
        { params: { id: currentCardId(accountId, cardId) }, body: { articleId, side } },
        { signal },
      );
    } catch (error) {
      if (!signal.aborted) announceTeachFailure(toast, why, cache, error);
      return;
    }
    if (signal.aborted) return;
    cache.apply(answer);
    announceTaught(toast, why, answer.card, side);
  }

  async function stopSuggesting(): Promise<void> {
    const { signal } = controller;
    let updated: Me;
    try {
      updated = await api.call(
        routes.meUpdate,
        { body: { preferences: { exampleSuggestions: false } } },
        { signal },
      );
    } catch (error) {
      if (!signal.aborted) toast.show({ message: errorMessage(i18n.t, error), tone: 'error' });
      return;
    }
    if (signal.aborted) return;
    if (queryClient.getQueryData<Me | null>(meKey())?.id === updated.id) {
      queryClient.setQueryData<Me | null>(meKey(), updated);
    }
    toast.show({ message: i18n.t('article:toast.suggestionsOff'), tone: 'success' });
  }

  return {
    async actionsFor(suggestion, articleId) {
      let cards: CardDto[];
      try {
        cards = await ensureCards(queryClient, api, accountId);
      } catch {
        return null;
      }
      const id = currentCardId(accountId, suggestion.cardId);
      const card = cards.find((candidate) => candidate.id === id);
      if (card === undefined) return null;
      return [
        {
          label: i18n.t(
            suggestion.side === 'no' ? 'article:toast.teachNo' : 'article:toast.teachYes',
            {
              title: card.title,
            },
          ),
          onAction: () => {
            void teach(suggestion, articleId);
          },
        },
        {
          label: i18n.t('article:toast.stopSuggesting'),
          onAction: () => {
            void stopSuggesting();
          },
        },
      ];
    },
    release() {
      controller.abort();
      controller = new AbortController();
    },
  };
}
