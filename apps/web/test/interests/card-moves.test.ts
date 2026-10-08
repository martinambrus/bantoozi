import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';

import {
  currentCardId,
  forgetCardMoves,
  recordCardMove,
} from '../../src/features/interests/card-moves.js';
import { cardCache, cardsKey } from '../../src/features/interests/queries.js';
import { runResetHooks, type ResetReason } from '../../src/session/reset.js';
import { USER_A_ID, USER_B_ID } from '../session/fixtures.js';
import { cardResult, makeCard } from './support.js';

afterEach(() => {
  forgetCardMoves();
});

describe('where a card went', () => {
  it('knows a card that never moved by its own id', () => {
    expect(currentCardId(USER_A_ID, '31')).toBe('31');
  });

  it('follows the move of a card to the id of the card that took its place', () => {
    recordCardMove(USER_A_ID, { from: '31', to: '35' });

    expect(currentCardId(USER_A_ID, '31')).toBe('35');
    expect(currentCardId(USER_A_ID, '35')).toBe('35');
    expect(currentCardId(USER_A_ID, '32')).toBe('32');
  });

  it('follows a card that moved more than once from any id on the way', () => {
    recordCardMove(USER_A_ID, { from: '31', to: '35' });
    recordCardMove(USER_A_ID, { from: '35', to: '36' });
    recordCardMove(USER_A_ID, { from: '36', to: '40' });

    for (const stored of ['31', '35', '36', '40']) {
      expect(currentCardId(USER_A_ID, stored)).toBe('40');
    }
  });

  it('keeps the moves of different cards apart', () => {
    recordCardMove(USER_A_ID, { from: '31', to: '35' });
    recordCardMove(USER_A_ID, { from: '32', to: '37' });
    recordCardMove(USER_A_ID, { from: '35', to: '36' });

    expect(currentCardId(USER_A_ID, '31')).toBe('36');
    expect(currentCardId(USER_A_ID, '32')).toBe('37');
  });

  it('keeps the accounts apart', () => {
    recordCardMove(USER_A_ID, { from: '31', to: '35' });

    expect(currentCardId(USER_A_ID, '31')).toBe('35');
    expect(currentCardId(USER_B_ID, '31')).toBe('31');
  });

  it('forgets everything on request', () => {
    recordCardMove(USER_A_ID, { from: '31', to: '35' });
    recordCardMove(USER_B_ID, { from: '41', to: '45' });

    forgetCardMoves();

    expect(currentCardId(USER_A_ID, '31')).toBe('31');
    expect(currentCardId(USER_B_ID, '41')).toBe('41');
  });

  it.each(['logout', 'account_switch', 'unauthorized', 'remote'] as const)(
    'forgets everything when the account is reset: %s',
    async (reason: ResetReason) => {
      recordCardMove(USER_A_ID, { from: '31', to: '35' });
      recordCardMove(USER_B_ID, { from: '41', to: '45' });

      await runResetHooks(reason);

      expect(currentCardId(USER_A_ID, '31')).toBe('31');
      expect(currentCardId(USER_B_ID, '41')).toBe('41');
    },
  );
});

describe('the moves the cards cache records', () => {
  const FORK = makeCard({
    id: '35',
    title: 'EV battery tech',
    origin: 'fork',
    isPrivateFork: true,
  });

  it('records every answer that changed an id, with the cards list or without it', () => {
    const queryClient = new QueryClient();
    const cache = cardCache(queryClient, USER_A_ID);

    cache.apply(cardResult(FORK, { from: '31', to: '35' }));
    queryClient.setQueryData(cardsKey(USER_A_ID), [makeCard({ id: '36' })]);
    cache.apply(cardResult(makeCard({ id: '37' }), { from: '36', to: '37' }));

    expect(currentCardId(USER_A_ID, '31')).toBe('35');
    expect(currentCardId(USER_A_ID, '36')).toBe('37');
    expect(currentCardId(USER_B_ID, '31')).toBe('31');
  });

  it('records nothing for an answer that left the id as it was', () => {
    const cache = cardCache(new QueryClient(), USER_A_ID);

    cache.apply(cardResult(makeCard({ id: '31' }), null));

    expect(currentCardId(USER_A_ID, '31')).toBe('31');
  });

  it('still puts the new card into the list in the place of the old one', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(cardsKey(USER_A_ID), [makeCard({ id: '31' }), makeCard({ id: '32' })]);

    cardCache(queryClient, USER_A_ID).apply(cardResult(FORK, { from: '31', to: '35' }));

    expect(
      queryClient.getQueryData<{ id: string }[]>(cardsKey(USER_A_ID))?.map((card) => card.id),
    ).toEqual(['35', '32']);
  });
});
