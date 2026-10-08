import type { CardDto, IdChange, Subscription } from '@bantoozi/shared';
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import { useMemo } from 'react';

import type { ApiClient } from '../../api/client.js';
import { useApi } from '../../api/context.js';
import { accountKey } from '../../api/query-keys.js';
import type { RouteOutput } from '../../api/route.js';
import { routes } from '../../api/routes.js';
import { useAccountId } from '../../session/context.js';
import { recordCardMove } from './card-moves.js';
import { mergeById } from './merge-by-id.js';

export type UpdateOffer = RouteOutput<typeof routes.libraryUpdateList>[number];
export type Suggestion = RouteOutput<typeof routes.cardSuggestionList>[number];
export type Topic = RouteOutput<typeof routes.topicList>[number];
export type LibraryPage = RouteOutput<typeof routes.libraryList>;
export type PublicationRequest = RouteOutput<typeof routes.cardPublicationRequestList>[number];

export function cardsKey(accountId: string) {
  return accountKey(accountId, 'cards');
}

/** The same entry the feeds screen fills, so both read one list of subscriptions. */
export function subscriptionsKey(accountId: string) {
  return accountKey(accountId, 'subscriptions');
}

export function topicsKey(accountId: string) {
  return accountKey(accountId, 'topics');
}

export function updatesKey(accountId: string) {
  return accountKey(accountId, 'library-updates');
}

export function requestsKey(accountId: string) {
  return accountKey(accountId, 'publication-requests');
}

export function suggestionsKey(accountId: string) {
  return accountKey(accountId, 'card-suggestions');
}

export function libraryKey(accountId: string) {
  return accountKey(accountId, 'library');
}

/** What the reader caches (lists, counts, explanations) and a card change can make stale. */
export function articlesKey(accountId: string) {
  return accountKey(accountId, 'articles');
}

export function useCards() {
  const api = useApi();
  const accountId = useAccountId();
  return useQuery({
    queryKey: cardsKey(accountId),
    queryFn: ({ signal }) => api.call(routes.cardList, undefined, { signal }),
  });
}

/** The cards the person holds as the cache has them, else as one read of the list gives them. */
export function ensureCards(
  queryClient: QueryClient,
  api: ApiClient,
  accountId: string,
): Promise<CardDto[]> {
  return queryClient.ensureQueryData({
    queryKey: cardsKey(accountId),
    queryFn: ({ signal }) => api.call(routes.cardList, undefined, { signal }),
  });
}

export function useSubscriptions() {
  const api = useApi();
  const accountId = useAccountId();
  return useQuery({
    queryKey: subscriptionsKey(accountId),
    queryFn: ({ signal }) => api.call(routes.subscriptionsList, undefined, { signal }),
  });
}

export function useTopics() {
  const api = useApi();
  const accountId = useAccountId();
  return useQuery({
    queryKey: topicsKey(accountId),
    queryFn: ({ signal }) => api.call(routes.topicList, undefined, { signal }),
  });
}

export function useUpdates() {
  const api = useApi();
  const accountId = useAccountId();
  return useQuery({
    queryKey: updatesKey(accountId),
    queryFn: ({ signal }) => api.call(routes.libraryUpdateList, undefined, { signal }),
  });
}

export function useRequests() {
  const api = useApi();
  const accountId = useAccountId();
  return useQuery({
    queryKey: requestsKey(accountId),
    queryFn: ({ signal }) => api.call(routes.cardPublicationRequestList, undefined, { signal }),
  });
}

export function useSuggestions() {
  const api = useApi();
  const accountId = useAccountId();
  return useQuery({
    queryKey: suggestionsKey(accountId),
    queryFn: ({ signal }) => api.call(routes.cardSuggestionList, undefined, { signal }),
  });
}

export interface LibraryFilters {
  topic: string | undefined;
  q: string | undefined;
}

/** The library, a page at a time; each combination of topic and search words is its own list. */
export function useLibrary({ topic, q }: LibraryFilters) {
  const api = useApi();
  const accountId = useAccountId();
  return useInfiniteQuery({
    queryKey: [...libraryKey(accountId), { topic: topic ?? null, q: q ?? null }],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.call(routes.libraryList, { query: { topic, q, cursor: pageParam } }, { signal }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/** The name a subscription goes by: the person's own, else the feed's, else its address. */
export function feedName(subscription: Subscription): string {
  return subscription.titleOverride ?? subscription.feed.title ?? subscription.feed.url;
}

function holdLibraryCard(data: InfiniteData<LibraryPage> | undefined, ids: readonly string[]) {
  if (data === undefined) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.map((item) => (ids.includes(item.id) ? { ...item, held: true } : item)),
    })),
  };
}

/**
 * Keeps the caches in step with what a card mutation just did. Cards are immutable, so an answer
 * can carry an `idChange`: the list takes the new id in the old one's place. Every change can
 * alter what the reader shows (rankings, explanations that name cards), so the account's article
 * queries are marked stale after each one.
 */
export function cardCache(queryClient: QueryClient, accountId: string) {
  const refreshArticles = () => {
    void queryClient.invalidateQueries({ queryKey: articlesKey(accountId) });
  };
  return {
    apply(result: { card: CardDto; idChange: IdChange | null }) {
      if (result.idChange !== null) recordCardMove(accountId, result.idChange);
      queryClient.setQueryData<CardDto[]>(cardsKey(accountId), (cards) =>
        cards === undefined ? cards : mergeById(cards, result.card, result.idChange),
      );
      void queryClient.invalidateQueries({ queryKey: updatesKey(accountId) });
      refreshArticles();
    },
    remove(id: string) {
      queryClient.setQueryData<CardDto[]>(cardsKey(accountId), (cards) =>
        cards?.filter((card) => card.id !== id),
      );
      void queryClient.invalidateQueries({ queryKey: updatesKey(accountId) });
      refreshArticles();
    },
    /** Shows a change before the server has answered; `undo` takes back only what it changed. */
    patch(id: string, changes: Partial<Pick<CardDto, 'strength' | 'scopeFeedId'>>) {
      const before = queryClient
        .getQueryData<CardDto[]>(cardsKey(accountId))
        ?.find((card) => card.id === id);
      queryClient.setQueryData<CardDto[]>(cardsKey(accountId), (cards) =>
        cards?.map((card) => (card.id === id ? { ...card, ...changes } : card)),
      );
      return before;
    },
    /** Puts back the fields that still hold the value `patch` gave them. */
    undo(
      id: string,
      before: Pick<CardDto, 'strength' | 'scopeFeedId'>,
      changes: Partial<Pick<CardDto, 'strength' | 'scopeFeedId'>>,
    ) {
      queryClient.setQueryData<CardDto[]>(cardsKey(accountId), (cards) =>
        cards?.map((card) => {
          if (card.id !== id) return card;
          const restored = { ...card };
          if (changes.strength !== undefined && card.strength === changes.strength) {
            restored.strength = before.strength;
          }
          if ('scopeFeedId' in changes && card.scopeFeedId === changes.scopeFeedId) {
            restored.scopeFeedId = before.scopeFeedId;
          }
          return restored;
        }),
      );
    },
    refreshCards() {
      void queryClient.invalidateQueries({ queryKey: cardsKey(accountId) });
    },
    refreshUpdates() {
      void queryClient.invalidateQueries({ queryKey: updatesKey(accountId) });
    },
    /** The person now holds these library cards. */
    hold(ids: readonly string[]) {
      queryClient.setQueriesData<InfiniteData<LibraryPage>>(
        { queryKey: libraryKey(accountId) },
        (data) => holdLibraryCard(data, ids),
      );
      queryClient.setQueryData<Suggestion[]>(suggestionsKey(accountId), (list) =>
        list?.filter((suggestion) => !ids.includes(suggestion.card.id)),
      );
    },
    refreshLibrary() {
      void queryClient.invalidateQueries({ queryKey: libraryKey(accountId) });
    },
    dropSuggestion(cardId: string) {
      queryClient.setQueryData<Suggestion[]>(suggestionsKey(accountId), (list) =>
        list?.filter((suggestion) => suggestion.card.id !== cardId),
      );
    },
    /** The server's answer to a response replaces the publication request it was about. */
    replaceRequest(request: PublicationRequest) {
      queryClient.setQueryData<PublicationRequest[]>(requestsKey(accountId), (list) =>
        list?.map((candidate) => (candidate.id === request.id ? request : candidate)),
      );
    },
    refreshRequests() {
      void queryClient.invalidateQueries({ queryKey: requestsKey(accountId) });
    },
    /** The library update of this held card has been dealt with. */
    dropOffer(currentCardId: string) {
      queryClient.setQueryData<UpdateOffer[]>(updatesKey(accountId), (list) =>
        list?.filter((offer) => offer.currentCardId !== currentCardId),
      );
    },
  };
}

export function useCardCache() {
  const queryClient = useQueryClient();
  const accountId = useAccountId();
  return useMemo(() => cardCache(queryClient, accountId), [queryClient, accountId]);
}
