import type { Me } from '@bantoozi/shared';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { meKey } from '../../src/api/query-keys.js';
import { storeSavedMe, withSavedFields } from '../../src/session/me.js';
import { USER_B_ID, makeMe } from './fixtures.js';

const DEMOTE = { clickbait: 'on', promotional: 'auto', shallow: 'auto', stale: 'auto' } as const;

describe('withSavedFields', () => {
  const shown = makeMe({
    displayName: 'Shown',
    preferences: { simpleMode: true, demote: DEMOTE, folderOrder: ['A', 'B'] },
  });

  it('takes the fields the save named from its answer and keeps the rest of the account shown', () => {
    const saved = makeMe({ displayName: 'Ada', locale: 'sk', preferences: { simpleMode: false } });

    const next = withSavedFields(shown, { displayName: 'Ada' }, saved);

    expect(next.displayName).toBe('Ada');
    expect(next.locale).toBe('en');
    expect(next.preferences).toEqual(shown.preferences);
  });

  it('takes a display name the save cleared', () => {
    const next = withSavedFields(shown, { displayName: null }, makeMe({ displayName: null }));

    expect(next.displayName).toBeNull();
  });

  it('takes the value the server holds, which may differ from the one sent', () => {
    const saved = makeMe({ timezone: 'UTC', preferences: { sort: 'score' } });

    const next = withSavedFields(
      shown,
      { timezone: 'Etc/UTC', preferences: { sort: 'date' } },
      saved,
    );

    expect(next.timezone).toBe('UTC');
    expect(next.preferences.sort).toBe('score');
  });

  it('takes only the named leaves of a nested preference', () => {
    const saved = makeMe({
      preferences: {
        demote: { clickbait: 'auto', promotional: 'off', shallow: 'on', stale: 'off' },
      },
    });

    const next = withSavedFields(shown, { preferences: { demote: { stale: 'off' } } }, saved);

    expect(next.preferences.demote).toEqual({ ...DEMOTE, stale: 'off' });
    expect(next.preferences.simpleMode).toBe(true);
  });

  it('takes the folder order whole', () => {
    const saved = makeMe({ preferences: { folderOrder: ['B', 'A', 'C'] } });

    const next = withSavedFields(shown, { preferences: { folderOrder: ['B', 'A'] } }, saved);

    expect(next.preferences.folderOrder).toEqual(['B', 'A', 'C']);
  });
});

describe('storeSavedMe', () => {
  it('shows the account with the saved fields and returns it', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<Me | null>(meKey(), makeMe({ preferences: { simpleMode: true } }));

    const stored = storeSavedMe(
      queryClient,
      { displayName: 'Ada' },
      makeMe({ displayName: 'Ada', preferences: { simpleMode: false } }),
    );

    expect(stored).toEqual(makeMe({ displayName: 'Ada', preferences: { simpleMode: true } }));
    expect(queryClient.getQueryData(meKey())).toBe(stored);
  });

  it('takes nothing after a sign-out or for another account', () => {
    const queryClient = new QueryClient();
    const saved = makeMe({ displayName: 'Ada' });

    queryClient.setQueryData<Me | null>(meKey(), null);
    expect(storeSavedMe(queryClient, { displayName: 'Ada' }, saved)).toBeNull();
    expect(queryClient.getQueryData(meKey())).toBeNull();

    const other = makeMe({ id: USER_B_ID });
    queryClient.setQueryData<Me | null>(meKey(), other);
    expect(storeSavedMe(queryClient, { displayName: 'Ada' }, saved)).toBeNull();
    expect(queryClient.getQueryData(meKey())).toBe(other);
  });
});
