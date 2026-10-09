import {
  mergeUserPreferences,
  type Me,
  type MePatch,
  type UserPreferences,
  type UserPreferencesPatch,
} from '@bantoozi/shared';
import { queryOptions, type QueryClient } from '@tanstack/react-query';

import type { ApiClient } from '../api/client.js';
import { isApiError } from '../api/errors.js';
import { meKey } from '../api/query-keys.js';
import { routes } from '../api/routes.js';

/** A navigation inside this time trusts the cached account; a window focus after it asks again. */
const ME_STALE_MS = 60_000;

/** `GET /me`, where the answer 401 is data: `null` means nobody is signed in. */
export function meQueryOptions(api: ApiClient) {
  return queryOptions({
    queryKey: meKey(),
    queryFn: async ({ signal }): Promise<Me | null> => {
      try {
        return await api.call(routes.meGet, undefined, { signal });
      } catch (error) {
        if (isApiError(error) && error.status === 401) return null;
        throw error;
      }
    },
    staleTime: ME_STALE_MS,
    // The route guard waits for this answer; offline it has to fail rather than pause until online.
    networkMode: 'always',
  });
}

/** What `saved` holds for each preference `patch` names, in the shape of `patch`. */
function savedLeaves(patch: UserPreferencesPatch, saved: UserPreferences): UserPreferencesPatch {
  const held = saved as unknown as Record<string, unknown>;
  const leaves: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const group = held[key];
    leaves[key] =
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(
            Object.keys(value).map((leaf) => [leaf, (group as Record<string, unknown>)[leaf]]),
          )
        : group;
  }
  return leaves as UserPreferencesPatch;
}

/**
 * `current` with each field a `PATCH /me` named at the value of its answer `saved`, and nothing
 * else from it. Saves can answer in another order than they were made, each with the whole account
 * as it stood when it was made, so the rest of an answer can be older than the account shown.
 */
export function withSavedFields(current: Me, patch: MePatch, saved: Me): Me {
  return {
    ...current,
    ...(patch.displayName === undefined ? {} : { displayName: saved.displayName }),
    ...(patch.locale === undefined ? {} : { locale: saved.locale }),
    ...(patch.timezone === undefined ? {} : { timezone: saved.timezone }),
    ...(patch.preferences === undefined
      ? {}
      : {
          preferences: mergeUserPreferences(
            current.preferences,
            savedLeaves(patch.preferences, saved.preferences),
          ),
        }),
  };
}

/**
 * Asks for the account again if a `GET /me` is on its way once a save's answer is shown: it may have
 * read the account before the save, and writing the cache leaves it running, so its answer would
 * put the saved fields back as they were. The new request reads them as saved.
 */
export function readMeAfterSave(queryClient: QueryClient): void {
  void queryClient.refetchQueries({ queryKey: meKey(), exact: true, fetchStatus: 'fetching' });
}

/**
 * Takes the answer of a `PATCH /me` into the account the app shows (`withSavedFields`), while that
 * account is still signed in. Returns the account as the cache holds it now, or null when nothing
 * was taken.
 */
export function storeSavedMe(queryClient: QueryClient, patch: MePatch, saved: Me): Me | null {
  const current = queryClient.getQueryData<Me | null>(meKey());
  if (!current || current.id !== saved.id) return null;
  const stored =
    queryClient.setQueryData<Me | null>(meKey(), withSavedFields(current, patch, saved)) ?? null;
  readMeAfterSave(queryClient);
  return stored;
}
