import type { Me, UserPreferences } from '@bantoozi/shared';
import type { QueryClient } from '@tanstack/react-query';

import type { ApiClient } from '../../api/client.js';
import { meKey } from '../../api/query-keys.js';
import { routes } from '../../api/routes.js';
import { subscriptionsKey } from '../feeds/subscriptions.js';

/** The preferences the reader's header changes. */
export type Setting = 'defaultTier' | 'sort' | 'simpleMode';
export type Settings = Partial<Pick<UserPreferences, Setting>>;

export interface SettingsWriter {
  /** Shows the new values at once and saves them; a refused save puts the old values back. */
  change(patch: Settings): void;
}

export interface SettingsWriterOptions {
  api: ApiClient;
  queryClient: QueryClient;
  /** Told when a save was refused, after the settings it covered are back. */
  onRefused: (error: unknown) => void;
}

const keysOf = (settings: Settings) => Object.keys(settings) as Setting[];

function pick(preferences: UserPreferences, keys: readonly Setting[]): Settings {
  return Object.fromEntries(keys.map((key) => [key, preferences[key]])) as Settings;
}

function without(settings: Settings, keys: readonly Setting[]): Settings {
  const rest = { ...settings };
  for (const key of keys) delete rest[key];
  return rest;
}

/**
 * Saves the header's settings (spec 09 §3.1). The account in the query cache is changed first, so
 * the list, the counts and the controls follow at once, and the change is sent with one request at
 * a time: what the reader changes meanwhile goes out together in the next request, so a slider that
 * keeps moving does not queue a request per step.
 */
export function createSettingsWriter({
  api,
  queryClient,
  onRefused,
}: SettingsWriterOptions): SettingsWriter {
  let sending = false;
  let waiting: Settings = {};
  // What the account holds for each setting that is not saved yet, to put back if saving fails.
  let confirmed: Settings = {};

  const account = () => queryClient.getQueryData<Me | null>(meKey()) ?? null;

  function show(me: Me, preferences: Settings): void {
    const next: Me = { ...me, preferences: { ...me.preferences, ...preferences } };
    queryClient.setQueryData<Me | null>(meKey(), next);
  }

  async function sendWaiting(): Promise<void> {
    if (sending) return;
    sending = true;
    try {
      while (keysOf(waiting).length > 0) {
        const body = waiting;
        waiting = {};
        // A setting the reader has moved again since stays as they left it.
        const settled = () => keysOf(body).filter((key) => !(key in waiting));
        const moved = () => keysOf(body).filter((key) => key in waiting);
        try {
          const updated = await api.call(routes.meUpdate, { body: { preferences: body } });
          confirmed = { ...without(confirmed, settled()), ...pick(updated.preferences, moved()) };
          // A sign-out or another account in the meantime must not get this account back. Only
          // what this request sent is taken: what another save changed since may be newer than the
          // rest of the answer.
          const me = account();
          if (me?.id === updated.id) {
            show(me, { ...pick(updated.preferences, keysOf(body)), ...waiting });
          }
          if ('defaultTier' in body) {
            void queryClient.invalidateQueries({ queryKey: subscriptionsKey(updated.id) });
          }
        } catch (error) {
          const me = account();
          if (me !== null) show(me, pick({ ...me.preferences, ...confirmed }, settled()));
          confirmed = without(confirmed, settled());
          onRefused(error);
        }
      }
    } finally {
      sending = false;
    }
  }

  return {
    change(patch) {
      const me = account();
      if (me === null) return;
      confirmed = { ...pick(me.preferences, keysOf(patch)), ...confirmed };
      waiting = { ...waiting, ...patch };
      show(me, patch);
      void sendWaiting();
    },
  };
}
