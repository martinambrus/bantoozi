import type { Me } from '@bantoozi/shared';
import { queryOptions } from '@tanstack/react-query';

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
