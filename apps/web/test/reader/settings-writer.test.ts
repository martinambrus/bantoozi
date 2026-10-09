import type { Me } from '@bantoozi/shared';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import type { ApiClient } from '../../src/api/client.js';
import { meKey } from '../../src/api/query-keys.js';
import { createSettingsWriter } from '../../src/features/reader/settings-writer.js';
import { USER_B_ID, makeMe } from '../session/fixtures.js';

/** A client whose `PATCH /me` answers when the test says so. */
function heldApi() {
  const answers: Array<(me: Me) => void> = [];
  const api = {
    call: () => new Promise<Me>((resolve) => answers.push(resolve)),
  } as unknown as ApiClient;
  return { api, answers };
}

/** A client whose `PATCH /me` requests the test answers or refuses one by one. */
function settledApi() {
  const requests: Array<{
    body: unknown;
    answer: (me: Me) => void;
    refuse: (error: Error) => void;
  }> = [];
  const api = {
    call: (_route: unknown, { body }: { body: unknown }) =>
      new Promise<Me>((answer, refuse) => requests.push({ body, answer, refuse })),
  } as unknown as ApiClient;
  return { api, requests };
}

const settle = async () => {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
};

describe('the reader settings writer', () => {
  it('takes only the settings it sent from the answer, keeping what another save changed meanwhile', async () => {
    const queryClient = new QueryClient();
    const before = makeMe();
    queryClient.setQueryData<Me | null>(meKey(), before);
    const { api, answers } = heldApi();
    const writer = createSettingsWriter({ api, queryClient, onRefused: () => {} });

    writer.change({ sort: 'date' });
    // Another save (the Why drawer) lands while this one is on its way; this request was made
    // first, so its answer still holds the demotion as it was.
    const shown = queryClient.getQueryData<Me>(meKey())!;
    const demoted: Me = {
      ...shown,
      preferences: { ...shown.preferences, demote: { ...shown.preferences.demote, stale: 'on' } },
    };
    queryClient.setQueryData<Me | null>(meKey(), demoted);
    answers[0]!({ ...before, preferences: { ...before.preferences, sort: 'date' } });
    await Promise.resolve();
    await Promise.resolve();

    const now = queryClient.getQueryData<Me>(meKey())!;
    expect(now.preferences.sort).toBe('date');
    expect(now.preferences.demote.stale).toBe('on');
  });

  describe('when the account signs out while a save is on its way', () => {
    const a = makeMe({ preferences: { sort: 'score', simpleMode: false } });
    const b = makeMe({
      id: USER_B_ID,
      email: 'b@example.com',
      preferences: { sort: 'date', simpleMode: false },
    });

    function signedInAsA() {
      const queryClient = new QueryClient();
      queryClient.setQueryData<Me | null>(meKey(), a);
      const { api, requests } = settledApi();
      const refusals: unknown[] = [];
      const writer = createSettingsWriter({
        api,
        queryClient,
        onRefused: (error) => refusals.push(error),
      });
      const preferences = () => queryClient.getQueryData<Me>(meKey())!.preferences;
      const signInAsB = () => queryClient.setQueryData<Me | null>(meKey(), b);
      return { queryClient, requests, refusals, writer, preferences, signInAsB };
    }

    it('puts none of its settings back into the next account when the save is refused', async () => {
      const { requests, refusals, writer, preferences, signInAsB } = signedInAsA();
      writer.change({ sort: 'date' });
      signInAsB();

      requests[0]!.refuse(new Error('refused'));
      await settle();

      expect(preferences()).toEqual(b.preferences);
      expect(refusals).toEqual([]);
    });

    it('sends none of the settings it changed after the save, for the next account', async () => {
      const { requests, writer, preferences, signInAsB } = signedInAsA();
      writer.change({ sort: 'date' });
      writer.change({ simpleMode: true });
      signInAsB();

      requests[0]!.answer({ ...a, preferences: { ...a.preferences, sort: 'date' } });
      await settle();

      expect(requests.map(({ body }) => body)).toEqual([{ preferences: { sort: 'date' } }]);
      expect(preferences()).toEqual(b.preferences);
    });

    it('saves what the next account changes as that account’s own', async () => {
      const { requests, refusals, writer, preferences, signInAsB } = signedInAsA();
      writer.change({ sort: 'date' });
      signInAsB();
      writer.change({ simpleMode: true });

      requests[0]!.refuse(new Error('refused'));
      await settle();
      expect(requests.map(({ body }) => body)).toEqual([
        { preferences: { sort: 'date' } },
        { preferences: { simpleMode: true } },
      ]);
      requests[1]!.refuse(new Error('refused'));
      await settle();

      expect(preferences()).toEqual(b.preferences);
      expect(refusals).toHaveLength(1);
    });

    it('forgets what it put aside, should the same account sign in again', async () => {
      const { queryClient, requests, writer, preferences } = signedInAsA();
      const saved: Me = { ...a, preferences: { ...a.preferences, sort: 'date' } };
      writer.change({ sort: 'date' });
      queryClient.setQueryData<Me | null>(meKey(), null);
      requests[0]!.answer(saved);
      await settle();

      queryClient.setQueryData<Me | null>(meKey(), saved);
      writer.change({ sort: 'score' });
      requests[1]!.refuse(new Error('refused'));
      await settle();

      expect(preferences().sort).toBe('date');
    });
  });
});
