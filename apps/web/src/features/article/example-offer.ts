import type { CardDto, Me } from '@bantoozi/shared';
import type { QueryClient } from '@tanstack/react-query';
import type { i18n as I18n } from 'i18next';

import type { ApiClient } from '../../api/client.js';
import type { RouteOutput } from '../../api/route.js';
import { routes } from '../../api/routes.js';
import { errorMessage } from '../../components/error-message.js';
import type { ToastApi } from '../../components/toast/toast-provider.js';
import type { ToastAction } from '../../components/toast/toast-store.js';
import { storeSavedMe } from '../../session/me.js';
import { currentCardId } from '../interests/card-moves.js';
import { cardCache, ensureCards } from '../interests/queries.js';
import type { DislikePattern, ExampleSuggestion } from '../reader/actions/types.js';
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
  /**
   * The actions that offer to teach the offered articles of a dislike pattern as "no" examples of
   * its card, or null when the pattern has no offer, the card is not among the ones the person
   * holds or the cards cannot be read.
   */
  patternActions(
    pattern: DislikePattern,
    articleId: string,
  ): Promise<readonly ToastAction[] | null>;
  patternEvent(
    pattern: DislikePattern,
    articleId: string,
    event: 'seen' | 'accepted' | 'dismissed',
  ): void;
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

  async function teachFewer(cardId: string, articleIds: string[]): Promise<void> {
    const { signal } = controller;
    let answer: RouteOutput<typeof routes.cardExamplesAdd>;
    try {
      answer = await api.call(
        routes.cardExamplesAdd,
        { params: { id: currentCardId(accountId, cardId) }, body: { articleIds, side: 'no' } },
        { signal },
      );
    } catch (error) {
      if (!signal.aborted) announceTeachFailure(toast, why, cache, error);
      return;
    }
    if (signal.aborted) return;
    cache.apply(answer);
    toast.show({
      message: i18n.t('article:toast.fewerTaught', { title: answer.card.title }),
      tone: 'success',
    });
  }

  async function stopSuggesting(): Promise<void> {
    const { signal } = controller;
    const patch = { preferences: { exampleSuggestions: false } };
    let updated: Me;
    try {
      updated = await api.call(routes.meUpdate, { body: patch }, { signal });
    } catch (error) {
      if (!signal.aborted) toast.show({ message: errorMessage(i18n.t, error), tone: 'error' });
      return;
    }
    if (signal.aborted) return;
    storeSavedMe(queryClient, patch, updated);
    toast.show({ message: i18n.t('article:toast.suggestionsOff'), tone: 'success' });
  }

  function patternEvent(
    pattern: DislikePattern,
    articleId: string,
    event: 'seen' | 'accepted' | 'dismissed',
  ): void {
    if (pattern.offerId === null) return;
    void api
      .call(
        routes.patternOfferEvent,
        { params: { id: articleId }, body: { offerId: pattern.offerId, event } },
        { signal: controller.signal },
      )
      .catch(() => {});
  }

  return {
    patternEvent,
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
    async patternActions(pattern, articleId) {
      const { offer } = pattern;
      if (offer === null) return null;
      let cards: CardDto[];
      try {
        cards = await ensureCards(queryClient, api, accountId);
      } catch {
        return null;
      }
      const id = currentCardId(accountId, pattern.cardId);
      if (!cards.some((candidate) => candidate.id === id)) return null;
      return [
        {
          label: i18n.t('article:toast.fewerLikeThese'),
          onAction: () => {
            patternEvent(pattern, articleId, 'accepted');
            void teachFewer(pattern.cardId, offer);
          },
        },
        {
          label: i18n.t('article:toast.notNow'),
          onAction: () => patternEvent(pattern, articleId, 'dismissed'),
        },
      ];
    },
    release() {
      controller.abort();
      controller = new AbortController();
    },
  };
}
