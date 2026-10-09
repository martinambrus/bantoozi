import { QueryClientProvider, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { ApiProvider } from '../../src/api/context.js';
import { accountKey, meKey } from '../../src/api/query-keys.js';
import { useRefresh } from '../../src/features/admin/use-admin.js';
import { useSubscriptionsCache } from '../../src/features/feeds/subscriptions.js';
import { currentCardId, forgetCardMoves } from '../../src/features/interests/card-moves.js';
import {
  articlesKey,
  cardsKey,
  libraryKey,
  requestsKey,
  suggestionsKey,
  updatesKey,
  useCardCache,
} from '../../src/features/interests/queries.js';
import { labelsKey, useLabelCache } from '../../src/features/labels/queries.js';
import { useRefreshAfterRuleChange } from '../../src/features/rules/use-rules.js';
import { SessionProvider } from '../../src/session/context.js';
import { makeSubscription } from '../feeds/support.js';
import {
  cardResult,
  makeCard,
  makeLibraryCard,
  makeOffer,
  makeRequest,
} from '../interests/support.js';
import { labelResult, makeLabel } from '../labels/support.js';
import { USER_A_ID as A, makeMe } from './fixtures.js';
import { trackSessions, type Server } from './support.js';

const sessions = trackSessions();

afterEach(() => {
  forgetCardMoves();
});

type Entries = ReadonlyArray<readonly [key: QueryKey, data: unknown]>;

/** A screen's cache helper, rendered in a session the account signed in to. */
function mount<Cache>(use: () => Cache) {
  const me = makeMe();
  const server: Server = { me };
  const started = sessions.start(server);
  const { queryClient, session } = started;
  queryClient.setQueryData(meKey(), me);
  const view = renderHook(use, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <ApiProvider client={session.api}>
          <SessionProvider session={session}>{children}</SessionProvider>
        </ApiProvider>
      </QueryClientProvider>
    ),
  });
  return { ...view, queryClient, session, server, me };
}

/** The screen is gone, the account signs out, and the same account signs in again. */
async function signInAgain(mounted: ReturnType<typeof mount>) {
  mounted.unmount();
  mounted.server.me = null;
  await act(() => mounted.session.resetAccountState());
  mounted.server.me = mounted.me;
  act(() => {
    mounted.queryClient.setQueryData(meKey(), mounted.me);
  });
}

function seed(queryClient: QueryClient, entries: Entries) {
  for (const [key, data] of entries) queryClient.setQueryData(key, data);
}

/** What each entry holds and whether it was marked stale. */
function observe(queryClient: QueryClient, entries: Entries) {
  return entries.map(([key]) => ({
    key,
    data: queryClient.getQueryData(key),
    invalidated: queryClient.getQueryState(key)?.isInvalidated,
  }));
}

/** The entries as they were seeded: unchanged and not marked stale. */
function untouched(entries: Entries) {
  return entries.map(([key, data]) => ({ key, data, invalidated: false }));
}

/**
 * For each write a helper hands out: called on the object a screen kept from before the account
 * signed out and in again, it changes nothing, and it changes the cache while the sign-in lasts.
 */
function describeHelper<Cache>(
  name: string,
  use: () => Cache,
  entries: Entries,
  writes: Record<string, (cache: Cache) => unknown>,
) {
  describe(name, () => {
    it.each(Object.entries(writes))(
      '%s changes nothing once the account has signed in again',
      async (_write, write) => {
        const mounted = mount(use);
        const kept = mounted.result.current;
        await signInAgain(mounted);
        seed(mounted.queryClient, entries);

        const returned = await write(kept);

        expect(observe(mounted.queryClient, entries)).toEqual(untouched(entries));
        expect(returned).toBeUndefined();
      },
    );

    it.each(Object.entries(writes))(
      '%s changes the cache while the sign-in lasts',
      async (_write, write) => {
        const mounted = mount(use);
        seed(mounted.queryClient, entries);

        await write(mounted.result.current);

        expect(observe(mounted.queryClient, entries)).not.toEqual(untouched(entries));
      },
    );
  });
}

const card = makeCard({ id: '101', strength: 'never' });
const libraryCard = makeLibraryCard({ id: '501' });
const request = makeRequest({ id: '7' });
const noArticles = { pages: [], pageParams: [] };

describeHelper(
  'the card cache',
  useCardCache,
  [
    [cardsKey(A), [card]],
    [updatesKey(A), [makeOffer({ currentCardId: '101' })]],
    [[...articlesKey(A), 'list'], noArticles],
    [
      [...libraryKey(A), { topic: null, q: null }],
      { pages: [{ items: [libraryCard], nextCursor: null }], pageParams: [undefined] },
    ],
    [suggestionsKey(A), [{ card: libraryCard, score: 0.8 }]],
    [requestsKey(A), [request]],
  ],
  {
    apply: (cache) => cache.apply(cardResult({ ...card, strength: 'must' })),
    remove: (cache) => cache.remove('101'),
    patch: (cache) => cache.patch('101', { strength: 'must' }),
    undo: (cache) =>
      cache.undo('101', { strength: 'like', scopeFeedId: null }, { strength: 'never' }),
    refreshCards: (cache) => cache.refreshCards(),
    refreshUpdates: (cache) => cache.refreshUpdates(),
    hold: (cache) => cache.hold(['501']),
    refreshLibrary: (cache) => cache.refreshLibrary(),
    dropSuggestion: (cache) => cache.dropSuggestion('501'),
    replaceRequest: (cache) => cache.replaceRequest({ ...request, status: 'approved' }),
    refreshRequests: (cache) => cache.refreshRequests(),
    dropOffer: (cache) => cache.dropOffer('101'),
  },
);

describe('the card cache and where a card went', () => {
  const moved = cardResult(makeCard({ id: '201' }), { from: '101', to: '201' });

  it('records no move of a card once the account has signed in again', async () => {
    const mounted = mount(useCardCache);
    const kept = mounted.result.current;
    await signInAgain(mounted);

    kept.apply(moved);

    expect(currentCardId(A, '101')).toBe('101');
  });

  it('records the move of a card while the sign-in lasts', () => {
    const mounted = mount(useCardCache);

    mounted.result.current.apply(moved);

    expect(currentCardId(A, '101')).toBe('201');
  });
});

describeHelper(
  'the label cache',
  useLabelCache,
  [
    [labelsKey(A), [makeLabel({ id: '31' })]],
    [[...articlesKey(A), 'list'], noArticles],
  ],
  {
    apply: (cache) => cache.apply(labelResult(makeLabel({ id: '31', name: 'Renamed' }))),
    remove: (cache) => cache.remove('31'),
  },
);

describeHelper(
  'the subscriptions cache',
  useSubscriptionsCache,
  [
    [
      accountKey(A, 'subscriptions'),
      [makeSubscription({ feed: { id: '11' } }), makeSubscription({ feed: { id: '12' } })],
    ],
  ],
  {
    replace: (cache) =>
      cache.replace(makeSubscription({ feed: { id: '11' }, titleOverride: 'My feed' })),
    mergeInference: (cache) =>
      cache.mergeInference(
        makeSubscription({
          feed: { id: '11' },
          inferenceMode: 'active',
          inferenceVersion: '2',
          inferenceActivatedAt: '2026-10-01T08:00:00.000Z',
        }),
      ),
    remove: (cache) => cache.remove('11'),
    refresh: (cache) => cache.refresh(),
  },
);

describeHelper(
  'the refresh of an admin screen',
  useRefresh,
  [[accountKey(A, 'admin', 'users'), { pages: [{ items: [], nextCursor: null }], pageParams: [] }]],
  { refresh: (refresh) => refresh('users') },
);

describeHelper(
  'the refresh after a rule changed',
  useRefreshAfterRuleChange,
  [
    [accountKey(A, 'rules', 'list'), []],
    [accountKey(A, 'articles', 'list'), noArticles],
  ],
  { refresh: (refresh) => refresh() },
);
