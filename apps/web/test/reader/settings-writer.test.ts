import type { Me } from '@bantoozi/shared';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import type { ApiClient } from '../../src/api/client.js';
import { meKey } from '../../src/api/query-keys.js';
import { createSettingsWriter } from '../../src/features/reader/settings-writer.js';
import { makeMe } from '../session/fixtures.js';

/** A client whose `PATCH /me` answers when the test says so. */
function heldApi() {
  const answers: Array<(me: Me) => void> = [];
  const api = {
    call: () => new Promise<Me>((resolve) => answers.push(resolve)),
  } as unknown as ApiClient;
  return { api, answers };
}

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
});
